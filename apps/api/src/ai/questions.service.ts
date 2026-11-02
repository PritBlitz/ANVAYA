import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { logger } from '../common/logger.js';
import { type RetrievedChunk, RetrievalService } from '../retrieval/retrieval.service.js';
import { AccessService } from '../workspaces/access.service.js';
import { AiClient, type EvidenceItem } from './ai-client.js';
import { aiErrorToApp, AiPolicyService } from './ai-policy.service.js';
import { UsageService } from './usage.service.js';

const log = logger('questions');

export const askBody = z
  .object({
    question: z.string().trim().min(3).max(2000),
    snapshot: z.union([z.literal('latest'), z.string().regex(/^[0-9a-f]{40}$/)]).default('latest'),
    mode: z.enum(['local', 'cloud', 'mock']).optional(),
    top_k: z.number().int().min(1).max(12).default(8),
    filters: z
      .object({
        languages: z.array(z.string().min(1).max(40)).max(20).optional(),
        paths: z.array(z.string().min(1).max(300)).max(20).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Re-validation of the AI service's structured answer at the trust boundary. */
const qaOutput = z.object({
  answer: z.string().min(1).max(4000),
  citations: z.array(z.object({ evidence_id: z.string(), supports: z.string().max(500) })).max(12),
  limitations: z.array(z.string().max(500)).max(8),
  insufficient_evidence: z.boolean(),
});

export function toEvidence(r: RetrievedChunk): EvidenceItem {
  return {
    id: r.chunk_id,
    path: r.file_path,
    start_line: r.start_line,
    end_line: r.end_line,
    commit_sha: r.commit_sha,
    content_hash: r.content_hash,
    language: r.language,
    symbol: r.symbol_name,
    content: r.content,
  };
}

/**
 * Grounded repository Q&A (ARCHITECTURE §5.2, FR-REP-010).
 * Citations returned to the client are built from server-side retrieval
 * records keyed by evidence id — never from model-provided paths or lines.
 */
@Injectable()
export class QuestionsService {
  constructor(
    private readonly access: AccessService,
    private readonly retrieval: RetrievalService,
    private readonly ai: AiClient,
    private readonly policy: AiPolicyService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
  ) {}

  async ask(userId: string, repositoryId: string, body: z.infer<typeof askBody>) {
    const { repository } = await this.access.requireRepository(userId, repositoryId);
    if (repository.status !== 'connected') throw Errors.invalidState('The repository is not connected.');
    const policy = await this.policy.load(repository.organization_id);
    const resolved = this.policy.resolve(policy, body.mode);

    const retrieved = await this.retrieval.search(repository, { query: body.question, snapshot: body.snapshot, topK: body.top_k, filters: body.filters, mode: 'hybrid' });
    const retrievalMeta = { ...retrieved.retrieval, result_count: retrieved.results.length };

    if (retrieved.results.length === 0) {
      // No evidence → no model call, no citations (refuse to invent).
      return {
        answer: 'No indexed evidence in this repository matched the question, so it cannot be answered with citations.',
        insufficient_evidence: true,
        citations: [],
        limitations: ['No relevant code was retrieved from the indexed snapshot.'],
        provider: null,
        model: null,
        mode: resolved.mode,
        prompt_version: null,
        data_disclosure: null,
        retrieval: { ...retrievalMeta, evidence_included: [] as string[] },
        usage: null,
      };
    }

    let gen;
    try {
      gen = await this.ai.generate({
        task: 'repository_qa',
        mode: resolved.mode,
        provider: resolved.provider,
        model: resolved.model,
        intent: { question: body.question, repository: repository.full_name },
        evidence: retrieved.results.map(toEvidence),
        budget: { max_input_tokens: policy.limits.max_input_tokens, max_output_tokens: policy.limits.max_output_tokens, timeout_seconds: policy.limits.request_timeout_seconds },
      });
    } catch (err) {
      throw aiErrorToApp(err);
    }

    const out = qaOutput.safeParse(gen.output);
    if (!out.success) throw Errors.upstream('INVALID_MODEL_OUTPUT', 'The model did not produce a valid structured answer.');
    const byId = new Map(retrieved.results.map((r) => [r.chunk_id, r]));
    const limitations = [...out.data.limitations];
    const citations = out.data.citations.flatMap((c) => {
      const r = byId.get(c.evidence_id);
      if (!r) return [];
      return [{ evidence_id: r.chunk_id, path: r.file_path, start_line: r.start_line, end_line: r.end_line, commit_sha: r.commit_sha, content_hash: r.content_hash, symbol: r.symbol_name, supports: c.supports }];
    });
    if (citations.length < out.data.citations.length) limitations.push('Some model citations did not match retrieved evidence and were removed.');
    const unsupported = !out.data.insufficient_evidence && citations.length === 0;
    if (unsupported) limitations.push('The answer is not supported by any citation and should be treated as unverified.');
    if (retrieved.retrieval.semantic !== 'ok' && retrieved.retrieval.semantic !== 'disabled') limitations.push('Semantic search was unavailable; evidence was retrieved lexically only.');

    await this.usage.record({
      organizationId: repository.organization_id,
      provider: gen.provider,
      model: gen.model,
      operation: 'repository_qa',
      inputTokens: gen.usage.input_tokens,
      outputTokens: gen.usage.output_tokens,
      estimatedCostMicrounits: gen.usage.estimated_cost_microunits ?? null,
      durationMs: gen.duration_ms,
    });
    if (resolved.mode === 'cloud') {
      await this.audit.record({
        organizationId: repository.organization_id,
        actorUserId: userId,
        action: 'ai.cloud_inference',
        resourceType: 'repository',
        resourceId: repository.id,
        metadata: { operation: 'repository_qa', provider: gen.provider, model: gen.model, data_categories: resolved.disclosure?.data_categories ?? [], evidence_items: gen.evidence_included.length },
      });
    }
    log.info({ repository_id: repository.id, provider: gen.provider, citations: citations.length }, 'question answered');
    return {
      answer: out.data.answer,
      insufficient_evidence: out.data.insufficient_evidence || unsupported,
      citations,
      limitations,
      provider: gen.provider,
      model: gen.model,
      mode: gen.mode,
      prompt_version: gen.prompt_version,
      data_disclosure: resolved.disclosure,
      retrieval: { ...retrievalMeta, evidence_included: gen.evidence_included },
      usage: { input_tokens: gen.usage.input_tokens, output_tokens: gen.usage.output_tokens, duration_ms: gen.duration_ms, schema_repair_attempted: gen.schema_repair_attempted },
    };
  }
}
