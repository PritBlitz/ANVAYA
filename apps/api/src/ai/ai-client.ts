import { Global, Injectable, Module } from '@nestjs/common';
import { Agent, fetch, type Response } from 'undici';
import { z, type ZodType } from 'zod';
import { logger } from '../common/logger.js';
import { metrics } from '../common/metrics.js';
import { requestContext } from '../common/request-context.js';
import { AppConfig } from '../config/config.js';

const log = logger('ai-client');

/**
 * Local models on CPU can take longer than 5 minutes per call, and the workspace policy allows
 * up to AI_REQUEST_TIMEOUT_MS. The default fetch dispatcher gives up after 300s without response
 * headers (undici's `headersTimeout`), which surfaced as a misleading AI_SERVICE_UNAVAILABLE. The
 * AI client therefore uses its own pool with those idle timers off: every call carries an
 * AbortSignal deadline, and that deadline alone decides when a call has timed out.
 */
const aiDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** Undici timeout codes, in case one fires anyway (e.g. a future dispatcher change). */
const TIMEOUT_CAUSES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT']);

export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError') return true;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' && TIMEOUT_CAUSES.has(cause.code);
}

/** Error from the AI service, normalized. `retryable` distinguishes transient failures. */
export class AiServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const embeddingResponse = z.object({
  provider: z.string(),
  model: z.string(),
  model_version: z.string(),
  dimension: z.number().int(),
  embeddings: z.array(z.array(z.number())),
  usage: z.object({ input_tokens: z.number().int().nullable().optional() }).default({}),
  duration_ms: z.number().int().nonnegative(),
});
export type EmbeddingResponse = z.infer<typeof embeddingResponse>;

export const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  estimated_cost_microunits: z.number().int().nonnegative().nullable().optional(),
});

export const generationResponse = z.object({
  task: z.string(),
  provider: z.string(),
  model: z.string(),
  mode: z.enum(['local', 'cloud', 'mock']),
  prompt_version: z.string(),
  /** Schema-validated by the AI service; re-validated by callers against their own Zod schema. */
  output: z.unknown(),
  /** Evidence ids that fit the token budget and were actually shown to the model. */
  evidence_included: z.array(z.string()).default([]),
  usage: usageSchema,
  duration_ms: z.number().int().nonnegative(),
  schema_repair_attempted: z.boolean(),
});
export type GenerationResponse = z.infer<typeof generationResponse>;

export const providerHealth = z.object({
  provider: z.string(),
  mode: z.enum(['local', 'cloud', 'mock']),
  available: z.boolean(),
  models: z.array(z.string()).default([]),
  detail: z.string().nullable().optional(),
});

export interface EvidenceItem {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  commit_sha: string;
  content_hash: string;
  language: string | null;
  symbol: string | null;
  content: string;
}

export interface GenerationRequest {
  task: 'repository_qa' | 'investigation' | 'planning' | 'patch' | 'repair' | 'review' | 'verification_summary';
  mode: 'local' | 'cloud' | 'mock';
  provider?: string | null;
  model?: string | null;
  /** Application-owned task intent (title/description/question). */
  intent: Record<string, unknown>;
  /** Untrusted repository evidence. The AI service labels it as such in prompts. */
  evidence: EvidenceItem[];
  /** User/issue-supplied text (task description, issue body); rendered as untrusted data. */
  untrusted_inputs?: Array<{ label: string; content: string }>;
  /** Additional trusted context (approved plan, diff summary, verification results). */
  context?: Record<string, unknown>;
  budget: { max_input_tokens: number; max_output_tokens: number; timeout_seconds: number };
}

/**
 * Client for the internal FastAPI AI service. The service owns providers,
 * prompts and output schemas; this side owns authorization, budgets and
 * persistence. Never sends credentials or environment values.
 */
@Injectable()
export class AiClient {
  constructor(private readonly config: AppConfig) {}

  async embed(texts: string[], inputType: 'document' | 'query'): Promise<EmbeddingResponse> {
    const res = await this.post('/internal/v1/embeddings', { texts, input_type: inputType }, embeddingResponse, this.config.env.AI_REQUEST_TIMEOUT_MS);
    if (res.embeddings.length !== texts.length) throw new AiServiceError('AI_BAD_RESPONSE', 'embedding count mismatch', 502, false);
    if (res.dimension !== this.config.env.EMBEDDING_DIMENSION || res.embeddings.some((e) => e.length !== res.dimension)) {
      throw new AiServiceError('EMBEDDING_DIMENSION_MISMATCH', `embedding dimension ${res.dimension} does not match the index (${this.config.env.EMBEDDING_DIMENSION})`, 502, false);
    }
    return res;
  }

  async generate(req: GenerationRequest): Promise<GenerationResponse> {
    const timeoutMs = Math.min(this.config.env.AI_REQUEST_TIMEOUT_MS, req.budget.timeout_seconds * 1000 + 5000);
    const started = Date.now();
    try {
      const res = await this.post('/internal/v1/generate', req, generationResponse, timeoutMs);
      metrics.modelCalls.inc({ task: req.task, mode: req.mode, provider: res.provider, outcome: 'ok' });
      metrics.modelDuration.observe({ task: req.task, provider: res.provider }, (Date.now() - started) / 1000);
      metrics.modelTokens.inc({ provider: res.provider, direction: 'input' }, res.usage.input_tokens);
      metrics.modelTokens.inc({ provider: res.provider, direction: 'output' }, res.usage.output_tokens);
      return res;
    } catch (err) {
      metrics.modelCalls.inc({ task: req.task, mode: req.mode, provider: req.provider ?? 'default', outcome: err instanceof AiServiceError ? err.code : 'error' });
      throw err;
    }
  }

  async health(mode: 'local' | 'cloud' | 'mock', provider?: string) {
    return this.post('/internal/v1/providers/health', { mode, provider: provider ?? null }, providerHealth, 15_000);
  }

  private async post<T extends ZodType>(path: string, body: unknown, schema: T, timeoutMs: number): Promise<z.infer<T>> {
    const url = new URL(path, this.config.env.AI_SERVICE_URL);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.env.AI_SERVICE_TOKEN ? { Authorization: `Bearer ${this.config.env.AI_SERVICE_TOKEN}` } : {}),
          'X-Request-Id': requestContext.requestId() ?? '',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        dispatcher: aiDispatcher,
      });
    } catch (err) {
      const timeout = isTimeoutError(err);
      const cause = (err as { cause?: { code?: unknown } }).cause?.code;
      log.warn({ path, timeout, timeout_ms: timeoutMs, cause: typeof cause === 'string' ? cause : undefined }, 'ai service request failed');
      throw new AiServiceError(timeout ? 'AI_TIMEOUT' : 'AI_SERVICE_UNAVAILABLE', timeout ? 'The AI service timed out.' : 'The AI service is unavailable.', timeout ? 504 : 503, true);
    }
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }) }).safeParse(payload);
      const code = err.success ? err.data.error.code : 'AI_SERVICE_ERROR';
      const message = err.success ? err.data.error.message : `AI service responded with ${res.status}`;
      throw new AiServiceError(code, message, res.status, res.status >= 500 || res.status === 429, err.success ? (err.data.error.details ?? {}) : {});
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new AiServiceError('AI_BAD_RESPONSE', 'The AI service returned an unexpected response.', 502, false);
    return parsed.data;
  }
}

@Global()
@Module({ providers: [AiClient], exports: [AiClient] })
export class AiClientModule {}
