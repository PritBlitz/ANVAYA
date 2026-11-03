import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AiClient, AiServiceError, type EvidenceItem } from '../ai/ai-client.js';
import { aiErrorToApp, AiPolicyService } from '../ai/ai-policy.service.js';
import { UsageService } from '../ai/usage.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { logger } from '../common/logger.js';
import { DatabaseService } from '../database/database.service.js';
import type { Repository } from '../database/types.js';
import { type KnowledgeHit, KnowledgeIndexService } from '../knowledge/knowledge-index.service.js';
import { type RetrievedChunk, RetrievalService } from '../retrieval/retrieval.service.js';
import { AccessService } from '../workspaces/access.service.js';

const log = logger('workspace-knowledge');

/** At most this many repositories are searched per request (bounded fan-out). */
export const MAX_SEARCH_REPOSITORIES = 25;
const SNIPPET_CHARS = 600;

export const workspaceSearchBody = z
  .object({
    query: z.string().trim().min(2).max(500),
    /** Restrict to these repositories (must belong to the workspace); default = every indexed repository. */
    repository_ids: z.array(z.uuid()).min(1).max(MAX_SEARCH_REPOSITORIES).optional(),
    top_k: z.number().int().min(1).max(50).default(20),
    per_repository: z.number().int().min(1).max(10).default(5),
    include_knowledge: z.boolean().default(true),
    mode: z.enum(['hybrid', 'lexical']).default('hybrid'),
  })
  .strict();

export const workspaceAskBody = z
  .object({
    question: z.string().trim().min(3).max(2000),
    repository_ids: z.array(z.uuid()).min(1).max(MAX_SEARCH_REPOSITORIES).optional(),
    mode: z.enum(['local', 'cloud', 'mock']).optional(),
    top_k: z.number().int().min(1).max(12).default(8),
    include_knowledge: z.boolean().default(true),
  })
  .strict();

const qaOutput = z.object({
  answer: z.string().min(1).max(4000),
  citations: z.array(z.object({ evidence_id: z.string(), supports: z.string().max(500) })).max(12),
  limitations: z.array(z.string().max(500)).max(8),
  insufficient_evidence: z.boolean(),
});

interface RepoRef {
  id: string;
  full_name: string;
}

type Hit =
  | { source: 'code'; repository: RepoRef; score: number; chunk: RetrievedChunk }
  | { source: 'knowledge'; repository: RepoRef; score: number; note: KnowledgeHit; commit_sha: string };

/**
 * Workspace-wide (cross-repository) search and grounded Q&A. Tenant scope comes from the
 * caller's verified membership; only repositories of that workspace are ever searched, each
 * through the same snapshot-scoped retrieval as single-repository search. Every result and
 * citation carries its repository provenance (id, full name, commit).
 */
@Injectable()
export class WorkspaceKnowledgeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly retrieval: RetrievalService,
    private readonly knowledge: KnowledgeIndexService,
    private readonly ai: AiClient,
    private readonly policy: AiPolicyService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
  ) {}

  /** Connected, indexed repositories of the workspace (optionally a requested subset). */
  private async repositories(workspaceId: string, ids?: string[]): Promise<{ repos: Repository[]; skipped: Array<{ id: string; full_name: string; reason: string }> }> {
    let q = this.database.db.selectFrom('repositories').selectAll().where('organization_id', '=', workspaceId).where('status', '=', 'connected');
    if (ids) q = q.where('id', 'in', ids);
    const rows = await q.orderBy('full_name').execute();
    if (ids && rows.length !== new Set(ids).size) throw Errors.notFound('Repository');
    const skipped = rows.filter((r) => !r.latest_indexed_commit_sha).map((r) => ({ id: r.id, full_name: r.full_name, reason: 'not indexed yet' }));
    const indexed = rows.filter((r) => r.latest_indexed_commit_sha);
    for (const r of indexed.slice(MAX_SEARCH_REPOSITORIES)) skipped.push({ id: r.id, full_name: r.full_name, reason: `only the first ${MAX_SEARCH_REPOSITORIES} repositories are searched` });
    return { repos: indexed.slice(0, MAX_SEARCH_REPOSITORIES), skipped };
  }

  private async gather(workspaceId: string, query: string, o: { ids?: string[]; perRepo: number; knowledge: boolean; mode: 'hybrid' | 'lexical' }) {
    const started = Date.now();
    const { repos, skipped } = await this.repositories(workspaceId, o.ids);
    const limitations: string[] = [];
    let mode = o.mode;
    let embedding: { vector: number[]; model: string; version: string } | null = null;
    if (mode === 'hybrid' && repos.length > 0) {
      try {
        const e = await this.ai.embed([query], 'query');
        embedding = { vector: e.embeddings[0]!, model: e.model, version: e.model_version };
      } catch (err) {
        if (!(err instanceof AiServiceError)) throw err;
        mode = 'lexical';
        limitations.push('Semantic search was unavailable; results are lexical only.');
      }
    }
    const hits: Hit[] = [];
    const perRepository: Array<{ id: string; full_name: string; commit_sha: string; results: number; semantic: string }> = [];
    // Sequential on purpose: bounded fan-out that never floods the database pool.
    for (const repo of repos) {
      const ref = { id: repo.id, full_name: repo.full_name };
      const res = await this.retrieval.search(repo, { query, snapshot: 'latest', topK: o.perRepo, mode, queryEmbedding: embedding });
      for (const c of res.results) hits.push({ source: 'code', repository: ref, score: c.score, chunk: c });
      if (res.retrieval.semantic === 'unavailable' && mode === 'hybrid' && res.retrieval.semantic_reason) limitations.push(`${repo.full_name}: semantic search unavailable (${res.retrieval.semantic_reason}).`);
      let notes = 0;
      if (o.knowledge) {
        const kn = await this.knowledge.search(repo.id, query, 2, embedding);
        notes = kn.length;
        // Knowledge scores use their own scale; rank them just below the repository's best code hit.
        const top = res.results[0]?.score ?? 0.01;
        kn.forEach((n, i) => hits.push({ source: 'knowledge', repository: ref, score: Number((top * (0.9 - i * 0.1)).toFixed(6)), note: n, commit_sha: res.retrieval.commit_sha }));
      }
      perRepository.push({ id: repo.id, full_name: repo.full_name, commit_sha: res.retrieval.commit_sha, results: res.results.length + notes, semantic: res.retrieval.semantic });
    }
    // Deterministic merge: every repository's hits are fused with the same RRF constant, so scores are comparable.
    hits.sort((a, b) => b.score - a.score || a.repository.full_name.localeCompare(b.repository.full_name) || idOf(a).localeCompare(idOf(b)));
    return { hits, repositories: perRepository, skipped, limitations, mode, duration_ms: Date.now() - started };
  }

  async search(userId: string, workspaceId: string, body: z.infer<typeof workspaceSearchBody>) {
    await this.access.requireWorkspace(userId, workspaceId);
    const g = await this.gather(workspaceId, body.query, { ids: body.repository_ids, perRepo: body.per_repository, knowledge: body.include_knowledge, mode: body.mode });
    return {
      query: body.query,
      results: g.hits.slice(0, body.top_k).map(resultView),
      repositories: g.repositories,
      skipped_repositories: g.skipped,
      retrieval: { mode: g.mode, repositories_searched: g.repositories.length, duration_ms: g.duration_ms },
      limitations: g.limitations,
    };
  }

  async ask(userId: string, workspaceId: string, body: z.infer<typeof workspaceAskBody>) {
    await this.access.requireWorkspace(userId, workspaceId);
    const policy = await this.policy.load(workspaceId);
    const resolved = this.policy.resolve(policy, body.mode);
    const g = await this.gather(workspaceId, body.question, { ids: body.repository_ids, perRepo: Math.min(4, body.top_k), knowledge: body.include_knowledge, mode: 'hybrid' });
    const chosen = g.hits.slice(0, body.top_k);
    const limitations = [...g.limitations];
    const base = { repositories: g.repositories, skipped_repositories: g.skipped, mode: resolved.mode, data_disclosure: resolved.disclosure };
    if (chosen.length === 0) {
      return { ...base, answer: 'No indexed evidence in this workspace matched the question, so it cannot be answered with citations.', insufficient_evidence: true, citations: [], limitations: [...limitations, 'No relevant code was retrieved from any indexed repository.'], provider: null, model: null, prompt_version: null, usage: null };
    }
    // Evidence ids are opaque; paths are prefixed with the repository so the model can tell repositories apart.
    const evidence: EvidenceItem[] = chosen.map(evidenceOf);
    let gen;
    try {
      gen = await this.ai.generate({
        task: 'repository_qa',
        mode: resolved.mode,
        provider: resolved.provider,
        model: resolved.model,
        intent: { question: body.question, scope: 'workspace', repositories: g.repositories.map((r) => r.full_name) },
        evidence,
        budget: { max_input_tokens: policy.limits.max_input_tokens, max_output_tokens: policy.limits.max_output_tokens, timeout_seconds: policy.limits.request_timeout_seconds },
      });
    } catch (err) {
      throw aiErrorToApp(err);
    }
    const out = qaOutput.safeParse(gen.output);
    if (!out.success) throw Errors.upstream('INVALID_MODEL_OUTPUT', 'The model did not produce a valid structured answer.');
    const byId = new Map(chosen.map((h) => [evidenceOf(h).id, h]));
    // Citations are rebuilt from server-side retrieval records; model-supplied ids that were not shown are dropped.
    const citations = out.data.citations.flatMap((c) => {
      const h = byId.get(c.evidence_id);
      return h ? [{ ...resultView(h), evidence_id: c.evidence_id, supports: c.supports }] : [];
    });
    if (citations.length < out.data.citations.length) limitations.push('Some model citations did not match retrieved evidence and were removed.');
    const unsupported = !out.data.insufficient_evidence && citations.length === 0;
    if (unsupported) limitations.push('The answer is not supported by any citation and should be treated as unverified.');
    await this.usage.record({ organizationId: workspaceId, provider: gen.provider, model: gen.model, operation: 'workspace_qa', inputTokens: gen.usage.input_tokens, outputTokens: gen.usage.output_tokens, estimatedCostMicrounits: gen.usage.estimated_cost_microunits ?? null, durationMs: gen.duration_ms });
    if (resolved.mode === 'cloud') {
      await this.audit.record({
        organizationId: workspaceId,
        actorUserId: userId,
        action: 'ai.cloud_inference',
        resourceType: 'workspace',
        resourceId: workspaceId,
        metadata: { operation: 'workspace_qa', provider: gen.provider, model: gen.model, data_categories: resolved.disclosure?.data_categories ?? [], evidence_items: gen.evidence_included.length, repositories: g.repositories.map((r) => r.id) },
      });
    }
    log.info({ workspace_id: workspaceId, repositories: g.repositories.length, citations: citations.length }, 'workspace question answered');
    return {
      ...base,
      answer: out.data.answer,
      insufficient_evidence: out.data.insufficient_evidence || unsupported,
      citations,
      limitations: [...limitations, ...out.data.limitations],
      provider: gen.provider,
      model: gen.model,
      mode: gen.mode,
      prompt_version: gen.prompt_version,
      usage: { input_tokens: gen.usage.input_tokens, output_tokens: gen.usage.output_tokens, duration_ms: gen.duration_ms, schema_repair_attempted: gen.schema_repair_attempted },
    };
  }
}

function idOf(h: Hit): string {
  return h.source === 'code' ? h.chunk.chunk_id : h.note.chunk_id;
}

function evidenceOf(h: Hit): EvidenceItem {
  if (h.source === 'code') {
    const c = h.chunk;
    return { id: c.chunk_id, path: `${h.repository.full_name}/${c.file_path}`, start_line: c.start_line, end_line: c.end_line, commit_sha: c.commit_sha, content_hash: c.content_hash, language: c.language, symbol: c.symbol_name, content: c.content };
  }
  const n = h.note;
  return { id: `kn_${n.chunk_id}`, path: `${h.repository.full_name}/anvaya-knowledge/${n.document_id}.md`, start_line: n.start_line, end_line: n.end_line, commit_sha: h.commit_sha, content_hash: n.content_hash, language: 'markdown', symbol: n.title.slice(0, 300), content: n.content };
}

function resultView(h: Hit) {
  if (h.source === 'code') {
    const c = h.chunk;
    return {
      source: 'code' as const,
      repository_id: h.repository.id,
      repository_full_name: h.repository.full_name,
      commit_sha: c.commit_sha,
      path: c.file_path,
      start_line: c.start_line,
      end_line: c.end_line,
      content_hash: c.content_hash,
      symbol: c.symbol_name,
      language: c.language,
      knowledge_document_id: null,
      title: null,
      snippet: c.content.length > SNIPPET_CHARS ? `${c.content.slice(0, SNIPPET_CHARS)}…` : c.content,
      score: h.score,
    };
  }
  const n = h.note;
  return {
    source: 'knowledge' as const,
    repository_id: h.repository.id,
    repository_full_name: h.repository.full_name,
    commit_sha: null,
    path: null,
    start_line: n.start_line,
    end_line: n.end_line,
    content_hash: n.content_hash,
    symbol: null,
    language: 'markdown',
    knowledge_document_id: n.document_id,
    title: n.title,
    snippet: n.content.length > SNIPPET_CHARS ? `${n.content.slice(0, SNIPPET_CHARS)}…` : n.content,
    score: h.score,
  };
}
