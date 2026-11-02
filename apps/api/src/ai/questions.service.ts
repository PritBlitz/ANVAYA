import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { logger } from '../common/logger.js';
import { decodeCursor, toPage } from '../common/http.js';
import { beforeCursor, cursorUs } from '../database/keyset.js';
import type { Selectable } from 'kysely';
import type { RepositoryQuestionsTable } from '../database/types.js';
import { DatabaseService } from '../database/database.service.js';
import { json } from '../database/types.js';
import { type KnowledgeHit, KnowledgeIndexService } from '../knowledge/knowledge-index.service.js';
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
    /** Also retrieve passages from the repository's knowledge notes (B-2). */
    include_knowledge: z.boolean().default(true),
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

export interface Citation {
  source: 'code' | 'knowledge';
  evidence_id: string;
  path: string | null;
  start_line: number;
  end_line: number;
  commit_sha: string | null;
  content_hash: string;
  symbol: string | null;
  knowledge_document_id: string | null;
  title: string | null;
  supports: string;
}

function historyView(r: Selectable<RepositoryQuestionsTable>) {
  return {
    id: r.id,
    repository_id: r.repository_id,
    question: r.question,
    answer: r.answer,
    insufficient_evidence: r.insufficient_evidence,
    citations: r.citations,
    limitations: r.limitations,
    provider: r.provider,
    model: r.model,
    mode: r.mode,
    commit_sha: r.commit_sha,
    created_at: r.created_at.toISOString(),
  };
}

const KNOWLEDGE_TOP_K = 3;
const KNOWLEDGE_ID_PREFIX = 'kn_';

export function knowledgeEvidence(k: KnowledgeHit, commitSha: string): EvidenceItem {
  return {
    id: `${KNOWLEDGE_ID_PREFIX}${k.chunk_id}`,
    // Synthetic, clearly non-repository path so the model can tell notes from code.
    path: `anvaya-knowledge/${k.document_id}.md`,
    start_line: k.start_line,
    end_line: k.end_line,
    commit_sha: commitSha,
    content_hash: k.content_hash,
    language: 'markdown',
    symbol: k.title.slice(0, 300),
    content: k.content,
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
    private readonly knowledge: KnowledgeIndexService,
    private readonly database: DatabaseService,
  ) {}

  async ask(userId: string, repositoryId: string, body: z.infer<typeof askBody>) {
    const { repository } = await this.access.requireRepository(userId, repositoryId);
    if (repository.status !== 'connected') throw Errors.invalidState('The repository is not connected.');
    const policy = await this.policy.load(repository.organization_id);
    const resolved = this.policy.resolve(policy, body.mode);

    const retrieved = await this.retrieval.search(repository, { query: body.question, snapshot: body.snapshot, topK: body.top_k, filters: body.filters, mode: 'hybrid' });
    const notes = body.include_knowledge ? await this.knowledge.search(repository.id, body.question, KNOWLEDGE_TOP_K, retrieved.queryEmbedding) : [];
    const retrievalMeta = { ...retrieved.retrieval, result_count: retrieved.results.length, knowledge_result_count: notes.length };

    if (retrieved.results.length === 0 && notes.length === 0) {
      // No evidence → no model call, no citations (refuse to invent).
      const answer = 'No indexed evidence in this repository matched the question, so it cannot be answered with citations.';
      const limitations = ['No relevant code was retrieved from the indexed snapshot.'];
      const saved = await this.saveHistory(repository, userId, body.question, { answer, insufficient: true, citations: [], limitations, provider: null, model: null, mode: resolved.mode, commitSha: retrieved.retrieval.commit_sha });
      return {
        id: saved.id,
        created_at: saved.created_at.toISOString(),
        answer,
        insufficient_evidence: true,
        citations: [],
        limitations,
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
        evidence: [...retrieved.results.map(toEvidence), ...notes.map((n) => knowledgeEvidence(n, retrieved.retrieval.commit_sha))],
        budget: { max_input_tokens: policy.limits.max_input_tokens, max_output_tokens: policy.limits.max_output_tokens, timeout_seconds: policy.limits.request_timeout_seconds },
      });
    } catch (err) {
      throw aiErrorToApp(err);
    }

    const out = qaOutput.safeParse(gen.output);
    if (!out.success) throw Errors.upstream('INVALID_MODEL_OUTPUT', 'The model did not produce a valid structured answer.');
    const byId = new Map(retrieved.results.map((r) => [r.chunk_id, r]));
    const notesById = new Map(notes.map((n) => [`${KNOWLEDGE_ID_PREFIX}${n.chunk_id}`, n]));
    const limitations = [...out.data.limitations];
    const citations = out.data.citations.flatMap((c): Citation[] => {
      const r = byId.get(c.evidence_id);
      if (r) {
        return [{ source: 'code', evidence_id: r.chunk_id, path: r.file_path, start_line: r.start_line, end_line: r.end_line, commit_sha: r.commit_sha, content_hash: r.content_hash, symbol: r.symbol_name, knowledge_document_id: null, title: null, supports: c.supports }];
      }
      const n = notesById.get(c.evidence_id);
      if (n) {
        return [{ source: 'knowledge', evidence_id: c.evidence_id, path: null, start_line: n.start_line, end_line: n.end_line, commit_sha: null, content_hash: n.content_hash, symbol: null, knowledge_document_id: n.document_id, title: n.title, supports: c.supports }];
      }
      return [];
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
    const insufficient = out.data.insufficient_evidence || unsupported;
    const saved = await this.saveHistory(repository, userId, body.question, {
      answer: out.data.answer,
      insufficient,
      citations,
      limitations,
      provider: gen.provider,
      model: gen.model,
      mode: gen.mode,
      commitSha: retrieved.retrieval.commit_sha,
    });
    return {
      id: saved.id,
      created_at: saved.created_at.toISOString(),
      answer: out.data.answer,
      insufficient_evidence: insufficient,
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
  /** Q&A history (B-8): kept per user; the answer is stored exactly as returned. */
  private saveHistory(
    repository: { id: string; organization_id: string },
    userId: string,
    question: string,
    a: { answer: string; insufficient: boolean; citations: unknown[]; limitations: string[]; provider: string | null; model: string | null; mode: string | null; commitSha: string | null },
  ) {
    return this.database.db
      .insertInto('repository_questions')
      .values({
        organization_id: repository.organization_id,
        repository_id: repository.id,
        user_id: userId,
        question,
        answer: a.answer,
        insufficient_evidence: a.insufficient,
        citations: json(a.citations),
        limitations: json(a.limitations),
        provider: a.provider,
        model: a.model,
        mode: a.mode,
        commit_sha: a.commitSha,
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();
  }
  async history(userId: string, repositoryId: string, q: { limit: number; cursor?: string }) {
    await this.access.requireRepository(userId, repositoryId);
    const cursor = decodeCursor(q.cursor);
    let query = this.database.db
      .selectFrom('repository_questions')
      .selectAll()
      .select(cursorUs('created_at').as('cursor_us'))
      .where('repository_id', '=', repositoryId)
      .where('user_id', '=', userId);
    if (cursor) query = query.where(beforeCursor('created_at', 'id', cursor));
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.limit + 1).execute();
    return toPage(rows, q.limit, ({ cursor_us: _c, ...r }) => historyView(r));
  }

  async getQuestion(userId: string, questionId: string) {
    const row = await this.ownQuestion(userId, questionId);
    return historyView(row);
  }

  async deleteQuestion(userId: string, questionId: string): Promise<void> {
    await this.ownQuestion(userId, questionId);
    await this.database.db.deleteFrom('repository_questions').where('id', '=', questionId).where('user_id', '=', userId).execute();
  }

  /** History is private to its author; other users (even admins) get 404. Access to the repository is re-checked. */
  private async ownQuestion(userId: string, questionId: string) {
    const row = await this.database.db.selectFrom('repository_questions').selectAll().where('id', '=', questionId).where('user_id', '=', userId).executeTakeFirst();
    if (!row) throw Errors.notFound('Question');
    await this.access.requireRepository(userId, row.repository_id).catch(() => {
      throw Errors.notFound('Question');
    });
    return row;
  }
}
