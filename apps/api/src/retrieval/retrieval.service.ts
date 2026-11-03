import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { AiClient, AiServiceError } from '../ai/ai-client.js';
import { Errors } from '../common/errors.js';
import { logger } from '../common/logger.js';
import { DatabaseService } from '../database/database.service.js';
import type { Database, Repository } from '../database/types.js';

const log = logger('retrieval');
const RRF_K = 60;
const CANDIDATES = 50;
const SNIPPET_CHARS = 1500;

export interface RetrievalFilters {
  languages?: string[];
  /** Path prefixes, e.g. "src/auth/". */
  paths?: string[];
}

export interface RetrievalQuery {
  query: string;
  /** 'latest' or a 40-char commit SHA. */
  snapshot: string;
  topK: number;
  filters?: RetrievalFilters;
  mode?: 'hybrid' | 'lexical' | 'semantic';
  /** Precomputed query embedding (e.g. one embedding shared by a workspace-wide search). */
  queryEmbedding?: { vector: number[]; model: string; version: string } | null;
}

export interface RetrievedChunk {
  chunk_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  commit_sha: string;
  /** Content hash of the source file at this commit (detects stale citations). */
  content_hash: string;
  chunk_hash: string;
  language: string | null;
  symbol_name: string | null;
  snippet: string;
  content: string;
  lexical_score: number | null;
  semantic_score: number | null;
  score: number;
}

export interface RetrievalResult {
  results: RetrievedChunk[];
  /** The query embedding, when one was computed (lets callers search other corpora without re-embedding). Internal; never serialized. */
  queryEmbedding?: { vector: number[]; model: string; version: string } | null;
  retrieval: {
    snapshot_id: string;
    commit_sha: string;
    snapshot_status: string;
    lexical: 'ok' | 'disabled';
    semantic: 'ok' | 'unavailable' | 'disabled';
    semantic_reason: string | null;
    embedding_model: string | null;
    lexical_candidates: number;
    semantic_candidates: number;
    duration_ms: number;
  };
}

/** Splits identifiers the same way the index does (camelCase, snake_case, paths). */
/**
 * English function words and question words. Terms are prefix-matched (`term:*`), so keeping them
 * lets "to" match every `token`/`toString` and "is" every `isValid`, drowning the words that carry
 * meaning; the retrieval benchmark (docs/evaluations/retrieval.md) measured this on natural-language
 * questions. Identifiers are unaffected: they are split into parts before this filter.
 */
const STOPWORDS = new Set(
  (
    'a an and are as at be been being but by can could did do does doing for from had has have how if in into is it its ' +
    'may might must my no not of on or our should so such than that the their them then there these they this those to ' +
    'too us was we were what when where which while who whom why will with would you your about after before during each ' +
    'get gets got any all also both either neither just only own same some very via vs'
  ).split(' '),
);

export function lexicalTerms(query: string): string[] {
  const spaced = query.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_./\\-]/g, ' ');
  const terms = spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && t.length <= 64);
  const unique = [...new Set(terms)];
  const meaningful = unique.filter((t) => !STOPWORDS.has(t));
  // A query made only of function words (e.g. "how is it") keeps them rather than matching nothing.
  return (meaningful.length > 0 ? meaningful : unique).slice(0, 32);
}

/**
 * Hybrid retrieval (ARCHITECTURE §8, AI_WORKFLOW §7). Context Retriever stage:
 * deterministic, no LLM. The caller must have authorized access to `repo`.
 */
@Injectable()
export class RetrievalService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ai: AiClient,
  ) {}

  async resolveSnapshot(repo: Repository, snapshot: string) {
    const sha = snapshot === 'latest' ? repo.latest_indexed_commit_sha : snapshot;
    if (!sha) throw Errors.conflict('REPOSITORY_NOT_INDEXED', 'This repository has not been indexed yet.');
    if (!/^[0-9a-f]{40}$/.test(sha)) throw Errors.validation({ issues: [{ path: 'snapshot', message: 'must be "latest" or a 40-character commit SHA', code: 'invalid_snapshot' }] });
    const snap = await this.database.db
      .selectFrom('repository_snapshots')
      .select(['id', 'commit_sha', 'status', 'embedding_model'])
      .where('repository_id', '=', repo.id)
      .where('commit_sha', '=', sha)
      .where('status', 'in', ['ready', 'partial'])
      .executeTakeFirst();
    if (!snap) throw Errors.notFound('Snapshot');
    return snap;
  }

  async search(repo: Repository, q: RetrievalQuery): Promise<RetrievalResult> {
    const started = Date.now();
    const snap = await this.resolveSnapshot(repo, q.snapshot);
    const mode = q.mode ?? 'hybrid';
    const filters = q.filters ?? {};

    const base = (exec: Kysely<Database> = this.database.db) => {
      let b = exec
        .selectFrom('code_chunks as c')
        .innerJoin('repository_files as f', 'f.id', 'c.repository_file_id')
        // Scope first: repository AND snapshot (tenant isolation is enforced by the caller's repository access check).
        .where('c.repository_id', '=', repo.id)
        .where('c.snapshot_id', '=', snap.id);
      if (filters.languages?.length) b = b.where('c.language', 'in', filters.languages);
      if (filters.paths?.length) {
        const prefixes = filters.paths;
        b = b.where((eb) => eb.or(prefixes.map((p) => eb('f.path', 'like', `${escapeLike(p)}%`))));
      }
      return b;
    };

    const lexical = new Map<string, { rank: number; score: number }>();
    const semantic = new Map<string, { rank: number; score: number }>();
    let semanticStatus: RetrievalResult['retrieval']['semantic'] = mode === 'lexical' ? 'disabled' : 'ok';
    let semanticReason: string | null = null;
    let queryEmbedding: RetrievalResult['queryEmbedding'] = null;

    if (mode !== 'semantic') {
      const terms = lexicalTerms(q.query);
      if (terms.length > 0) {
        const tsq = terms.map((t) => `${t}:*`).join(' | ');
        const rows = await base()
          .select(['c.id', sql<number>`ts_rank_cd(c.search_vector, to_tsquery('simple', ${tsq}))`.as('rank_score')])
          .where(sql<boolean>`c.search_vector @@ to_tsquery('simple', ${tsq})`)
          .orderBy('rank_score', 'desc')
          .orderBy('c.id')
          .limit(CANDIDATES)
          .execute();
        rows.forEach((r, i) => lexical.set(r.id, { rank: i + 1, score: Number(r.rank_score) }));
      }
    }

    if (mode !== 'lexical') {
      try {
        if (q.queryEmbedding) queryEmbedding = q.queryEmbedding;
        else {
          const e = await this.ai.embed([q.query], 'query');
          queryEmbedding = { vector: e.embeddings[0]!, model: e.model, version: e.model_version };
        }
        const emb = { model: queryEmbedding.model, model_version: queryEmbedding.version, embeddings: [queryEmbedding.vector] };
        const modelTag = `${emb.model}@${emb.model_version}`;
        if (snap.embedding_model && snap.embedding_model !== modelTag) {
          semanticStatus = 'unavailable';
          semanticReason = `query embedding model ${modelTag} does not match the index (${snap.embedding_model}); re-index required`;
        } else {
          const vec = `[${emb.embeddings[0]!.join(',')}]`;
          // Ordered by distance alone so the HNSW index is usable; ties are broken by id below.
          const rows = await this.database.transaction(async (tx) => {
            await withVectorScan(tx);
            return base(tx)
              .select(['c.id', sql<number>`1 - (c.embedding <=> ${vec}::vector)`.as('similarity')])
              .where('c.embedding', 'is not', null)
              .where('c.embedding_model', '=', emb.model)
              .where('c.embedding_version', '=', emb.model_version)
              .orderBy(sql`c.embedding <=> ${vec}::vector`)
              .limit(CANDIDATES)
              .execute();
          });
          rows
            .map((r) => ({ id: r.id, score: Number(r.similarity) }))
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
            .forEach((r, i) => semantic.set(r.id, { rank: i + 1, score: r.score }));
        }
      } catch (err) {
        if (!(err instanceof AiServiceError)) throw err;
        semanticStatus = 'unavailable';
        semanticReason = err.code;
        log.warn({ code: err.code }, 'semantic retrieval unavailable; lexical results only');
      }
    }

    // Deterministic reciprocal-rank fusion with id tiebreak.
    const ids = new Set([...lexical.keys(), ...semantic.keys()]);
    const fused = [...ids]
      .map((id) => ({
        id,
        score: (lexical.has(id) ? 1 / (RRF_K + lexical.get(id)!.rank) : 0) + (semantic.has(id) ? 1 / (RRF_K + semantic.get(id)!.rank) : 0),
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, q.topK);

    const details = fused.length
      ? await this.database.db
          .selectFrom('code_chunks as c')
          .innerJoin('repository_files as f', 'f.id', 'c.repository_file_id')
          .select(['c.id', 'f.path', 'c.start_line', 'c.end_line', 'f.content_hash', 'c.content_hash as chunk_hash', 'c.language', 'c.symbol_name', 'c.content'])
          .where(
            'c.id',
            'in',
            fused.map((f) => f.id),
          )
          .where('c.snapshot_id', '=', snap.id)
          .execute()
      : [];
    const byId = new Map(details.map((d) => [d.id, d]));
    const results: RetrievedChunk[] = fused
      .filter((f) => byId.has(f.id))
      .map((f) => {
        const d = byId.get(f.id)!;
        return {
          chunk_id: d.id,
          file_path: d.path,
          start_line: d.start_line,
          end_line: d.end_line,
          commit_sha: snap.commit_sha,
          content_hash: d.content_hash,
          chunk_hash: d.chunk_hash,
          language: d.language,
          symbol_name: d.symbol_name,
          snippet: d.content.length > SNIPPET_CHARS ? `${d.content.slice(0, SNIPPET_CHARS)}…` : d.content,
          content: d.content,
          lexical_score: lexical.get(f.id)?.score ?? null,
          semantic_score: semantic.get(f.id)?.score ?? null,
          score: Number(f.score.toFixed(6)),
        };
      });

    return {
      results,
      queryEmbedding,
      retrieval: {
        snapshot_id: snap.id,
        commit_sha: snap.commit_sha,
        snapshot_status: snap.status,
        lexical: mode === 'semantic' ? 'disabled' : 'ok',
        semantic: semanticStatus,
        semantic_reason: semanticReason,
        embedding_model: snap.embedding_model,
        lexical_candidates: lexical.size,
        semantic_candidates: semantic.size,
        duration_ms: Date.now() - started,
      },
    };
  }
}

/**
 * Session settings for filtered approximate-nearest-neighbour queries (B-5):
 * iterative HNSW scans keep returning rows until the LIMIT is met after the
 * snapshot/model filters, in exact distance order. Must run inside a transaction.
 */
export async function withVectorScan(tx: Kysely<Database>): Promise<void> {
  await sql`SET LOCAL hnsw.iterative_scan = strict_order`.execute(tx);
  await sql`SET LOCAL hnsw.ef_search = 100`.execute(tx);
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
