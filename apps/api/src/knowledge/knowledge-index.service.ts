import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AiClient, AiServiceError } from '../ai/ai-client.js';
import { sha256Hex } from '../common/crypto.js';
import { logger } from '../common/logger.js';
import { DatabaseService } from '../database/database.service.js';
import { chunkFile } from '../indexing/chunker.js';
import { lexicalTerms } from '../retrieval/retrieval.service.js';
import { ObjectStorage } from '../storage/object-storage.js';

const log = logger('knowledge-index');

const RRF_K = 60;
const CANDIDATES = 40;
const EMBED_BATCH = 32;
/** Unindexed notes picked up lazily per search (covers notes written before indexing existed or while the AI service was down). */
const LAZY_INDEX_LIMIT = 5;

export interface KnowledgeHit {
  chunk_id: string;
  document_id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  score: number;
}

/**
 * Makes knowledge notes retrievable (B-2): notes are chunked by lines and
 * embedded with the same model as code when the AI service is available;
 * otherwise they stay lexically searchable. Note content is untrusted
 * evidence, exactly like repository files.
 */
@Injectable()
export class KnowledgeIndexService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: ObjectStorage,
    private readonly ai: AiClient,
  ) {}

  /** (Re)builds the chunks of one note. Never throws for embedding failures. */
  async indexDocument(documentId: string, content?: string): Promise<{ chunks: number; embedded: number }> {
    const db = this.database.db;
    const doc = await db.selectFrom('knowledge_documents').selectAll().where('id', '=', documentId).executeTakeFirst();
    if (!doc?.repository_id) return { chunks: 0, embedded: 0 };
    let text = content;
    if (text === undefined) {
      const blob = doc.content_object_key ? await this.storage.get(doc.content_object_key) : null;
      text = blob?.toString('utf8') ?? '';
    }
    const header = `# ${doc.title}`;
    const chunks = chunkFile(text, []);
    const repositoryId = doc.repository_id;
    const ids = await this.database.transaction(async (tx) => {
      await tx.deleteFrom('knowledge_chunks').where('document_id', '=', documentId).execute();
      if (chunks.length === 0) return [] as string[];
      const rows = await tx
        .insertInto('knowledge_chunks')
        .values(
          chunks.map((c) => ({
            document_id: documentId,
            organization_id: doc.organization_id,
            repository_id: repositoryId,
            chunk_index: c.index,
            start_line: c.startLine,
            end_line: c.endLine,
            content: c.content,
            content_hash: `sha256:${sha256Hex(c.content)}`,
          })),
        )
        .returning(['id', 'content'])
        .execute();
      return rows.map((r) => r.id);
    });

    let embedded = 0;
    try {
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const res = await this.ai.embed(
          batch.map((c) => `${header}\n\n${c.content}`),
          'document',
        );
        await this.database.transaction(async (tx) => {
          for (let j = 0; j < batch.length; j++) {
            await tx
              .updateTable('knowledge_chunks')
              .set({ embedding: `[${res.embeddings[j]!.join(',')}]`, embedding_model: res.model, embedding_version: res.model_version })
              .where('id', '=', ids[i + j]!)
              .execute();
          }
        });
        embedded += batch.length;
      }
    } catch (err) {
      log.warn({ document_id: documentId, code: err instanceof AiServiceError ? err.code : 'UNEXPECTED' }, 'knowledge embedding unavailable; note is searchable lexically only');
    }
    await db.updateTable('knowledge_documents').set({ indexed_at: sql`now()` }).where('id', '=', documentId).execute();
    return { chunks: chunks.length, embedded };
  }

  /** Hybrid (lexical + semantic, RRF) search over one repository's notes. */
  async search(repositoryId: string, query: string, topK: number, queryEmbedding?: { vector: number[]; model: string; version: string } | null): Promise<KnowledgeHit[]> {
    const db = this.database.db;
    const pending = await db.selectFrom('knowledge_documents').select('id').where('repository_id', '=', repositoryId).where('indexed_at', 'is', null).limit(LAZY_INDEX_LIMIT).execute();
    for (const p of pending) await this.indexDocument(p.id);

    const lexical = new Map<string, number>();
    const terms = lexicalTerms(query);
    if (terms.length > 0) {
      const tsq = terms.map((t) => `${t}:*`).join(' | ');
      const rows = await db
        .selectFrom('knowledge_chunks as k')
        .select(['k.id', sql<number>`ts_rank_cd(k.search_vector, to_tsquery('simple', ${tsq}))`.as('rank_score')])
        .where('k.repository_id', '=', repositoryId)
        .where(sql<boolean>`k.search_vector @@ to_tsquery('simple', ${tsq})`)
        .orderBy('rank_score', 'desc')
        .orderBy('k.id')
        .limit(CANDIDATES)
        .execute();
      rows.forEach((r, i) => lexical.set(r.id, i + 1));
    }
    const semantic = new Map<string, number>();
    if (queryEmbedding) {
      const vec = `[${queryEmbedding.vector.join(',')}]`;
      const rows = await db
        .selectFrom('knowledge_chunks as k')
        .select(['k.id'])
        .where('k.repository_id', '=', repositoryId)
        .where('k.embedding', 'is not', null)
        .where('k.embedding_model', '=', queryEmbedding.model)
        .where('k.embedding_version', '=', queryEmbedding.version)
        .orderBy(sql`k.embedding <=> ${vec}::vector`)
        .limit(CANDIDATES)
        .execute();
      rows.forEach((r, i) => semantic.set(r.id, i + 1));
    }
    const scored = [...new Set([...lexical.keys(), ...semantic.keys()])]
      .map((id) => ({ id, score: (lexical.has(id) ? 1 / (RRF_K + lexical.get(id)!) : 0) + (semantic.has(id) ? 1 / (RRF_K + semantic.get(id)!) : 0) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, topK);
    if (scored.length === 0) return [];
    const rows = await db
      .selectFrom('knowledge_chunks as k')
      .innerJoin('knowledge_documents as d', 'd.id', 'k.document_id')
      .select(['k.id', 'k.document_id', 'd.title', 'd.source_type', 'd.source_url', 'k.start_line', 'k.end_line', 'k.content', 'k.content_hash'])
      .where(
        'k.id',
        'in',
        scored.map((s) => s.id),
      )
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return scored.flatMap((s) => {
      const r = byId.get(s.id);
      return r ? [{ chunk_id: r.id, document_id: r.document_id, title: r.title, source_type: r.source_type, source_url: r.source_url, start_line: r.start_line, end_line: r.end_line, content: r.content, content_hash: r.content_hash, score: s.score }] : [];
    });
  }
}
