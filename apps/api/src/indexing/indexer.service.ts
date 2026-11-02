import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AiClient, AiServiceError } from '../ai/ai-client.js';
import { AuditService } from '../audit/audit.service.js';
import { sha256Hex } from '../common/crypto.js';
import { logger } from '../common/logger.js';
import { metrics } from '../common/metrics.js';
import { AppConfig } from '../config/config.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { json, type ParseStatus, type Repository } from '../database/types.js';
import { effectiveSettings } from '../repositories/repositories.service.js';
import { blobKey, ObjectStorage } from '../storage/object-storage.js';
import { CHUNKER_VERSION, chunkFile, embeddingText } from './chunker.js';
import { classifyContent, classifyPath, detectLanguage, type ExclusionReason } from './classifier.js';
import { PARSER_VERSION, ParserService, type ParseResult } from './parser.service.js';
import { RepositorySource, type SourceFile, type SourceLimits } from './sources.js';

const log = logger('indexer');

export const INDEX_LIMITS = {
  maxArchiveBytes: 300 * 1024 * 1024,
  maxFiles: 20_000,
  fileBatch: 50,
  embedBatch: 32,
} as const;

class IndexingCancelled extends Error {}
class IndexingFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type RepoWithInstallation = Repository & { external_installation_id: number | null; installation_status: string | null };

interface FileRecord {
  path: string;
  byteSize: number;
  contentHash: string;
  language: string | null;
  fileType: string | null;
  lineCount: number | null;
  excluded: boolean;
  exclusionReason: ExclusionReason | null;
  parseStatus: ParseStatus;
  text?: string;
  parse?: ParseResult;
  reuseFromFileId?: string;
}

/**
 * Repository indexing pipeline (ARCHITECTURE §5.1, §8):
 * snapshot → classification → parsing → symbols → chunks → embeddings.
 *
 * Indexed by commit SHA; incremental across commits by reusing unchanged files
 * (same path + content hash + parser/chunker version). Coverage is reported
 * honestly: excluded, unparsed, failed and un-embedded content is visible.
 */
@Injectable()
export class IndexerService {
  constructor(
    private readonly database: DatabaseService,
    private readonly source: RepositorySource,
    private readonly parser: ParserService,
    private readonly ai: AiClient,
    private readonly storage: ObjectStorage,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /**
   * @param finalAttempt when false, transient failures re-queue the durable job and rethrow so the queue retries.
   */
  async run(indexingJobId: string, opts: { finalAttempt: boolean } = { finalAttempt: true }): Promise<void> {
    const db = this.database.db;
    const job = await db.selectFrom('indexing_jobs').selectAll().where('id', '=', indexingJobId).executeTakeFirst();
    if (!job || !['queued', 'running'].includes(job.status)) {
      log.info({ indexing_job_id: indexingJobId, status: job?.status }, 'indexing job no longer active; skipping');
      return;
    }
    const repo = await this.loadRepository(job.repository_id, job.organization_id);
    let snapshotId: string | null = null;
    try {
      if (!repo || repo.status !== 'connected') throw new IndexingFailure('REPOSITORY_NOT_CONNECTED', 'The repository is not connected.');
      if (this.config.env.REPOSITORY_SOURCE === 'github' && repo.installation_status !== 'active') {
        throw new IndexingFailure('INSTALLATION_INACTIVE', 'The GitHub installation is not active.');
      }
      await db
        .updateTable('indexing_jobs')
        .set({ status: 'running', stage: 'resolving_commit', attempts: sql`attempts + 1`, started_at: sql`coalesce(started_at, now())` })
        .where('id', '=', job.id)
        .where('status', 'in', ['queued', 'running'])
        .execute();
      await db.updateTable('repositories').set({ indexing_status: 'indexing' }).where('id', '=', repo.id).execute();

      const commitSha = job.commit_sha ?? (await this.source.resolveCommit(repo, job.requested_ref));
      if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new IndexingFailure('INVALID_COMMIT', 'Could not resolve a commit SHA.');
      await db.updateTable('indexing_jobs').set({ commit_sha: commitSha }).where('id', '=', job.id).execute();

      const existing = await db.selectFrom('repository_snapshots').selectAll().where('repository_id', '=', repo.id).where('commit_sha', '=', commitSha).executeTakeFirst();
      if (existing && ['ready', 'partial'].includes(existing.status) && existing.parser_version === PARSER_VERSION && existing.chunker_version === CHUNKER_VERSION) {
        await this.finishUnchanged(job.id, repo, existing.id, existing.status as 'ready' | 'partial', commitSha);
        return;
      }
      if (existing) await db.deleteFrom('repository_snapshots').where('id', '=', existing.id).execute();

      const base = await db
        .selectFrom('repository_snapshots')
        .select(['id', 'commit_sha'])
        .where('repository_id', '=', repo.id)
        .where('status', 'in', ['ready', 'partial'])
        .where('parser_version', '=', PARSER_VERSION)
        .where('chunker_version', '=', CHUNKER_VERSION)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();

      const snapshot = await db
        .insertInto('repository_snapshots')
        .values({
          repository_id: repo.id,
          commit_sha: commitSha,
          branch_name: job.requested_ref ?? repo.default_branch,
          status: 'processing',
          parser_version: PARSER_VERSION,
          chunker_version: CHUNKER_VERSION,
          base_snapshot_id: base?.id ?? null,
          language_stats: json({}),
          started_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      snapshotId = snapshot.id;
      await db.updateTable('indexing_jobs').set({ snapshot_id: snapshotId, stage: 'fetching' }).where('id', '=', job.id).execute();

      const settings = effectiveSettings(repo.settings);
      const limits: SourceLimits = { maxArchiveBytes: INDEX_LIMITS.maxArchiveBytes, maxFiles: INDEX_LIMITS.maxFiles, maxFileBytes: settings.max_file_bytes };
      const fetched = await this.source.fetch(repo, commitSha, limits);

      const baseFiles = new Map<string, { id: string; content_hash: string }>();
      if (base) {
        const rows = await db
          .selectFrom('repository_files')
          .select(['id', 'path', 'content_hash'])
          .where('snapshot_id', '=', base.id)
          .where('is_excluded', '=', false)
          .execute();
        for (const r of rows) baseFiles.set(r.path, { id: r.id, content_hash: r.content_hash });
      }

      let processed = 0;
      let reused = 0;
      let failed = 0;
      for (let i = 0; i < fetched.files.length; i += INDEX_LIMITS.fileBatch) {
        await this.assertNotCancelled(job.id);
        const batch = fetched.files.slice(i, i + INDEX_LIMITS.fileBatch);
        const records: FileRecord[] = [];
        for (const f of batch) {
          const rec = await this.processFile(repo, f, settings.exclude_paths, settings.max_file_bytes, baseFiles);
          if (rec.reuseFromFileId) reused++;
          if (rec.parseStatus === 'parse_error') failed++;
          records.push(rec);
        }
        await this.database.transaction((tx) => this.persistBatch(tx, repo, snapshotId!, records));
        processed += batch.length;
        await db
          .updateTable('indexing_jobs')
          .set({ stage: 'processing_files', progress: json({ files_total: fetched.files.length, files_processed: processed, files_reused: reused }) })
          .where('id', '=', job.id)
          .execute();
      }

      await db.updateTable('indexing_jobs').set({ stage: 'resolving_relationships' }).where('id', '=', job.id).execute();
      await this.resolveRelationships(snapshotId);

      await db.updateTable('indexing_jobs').set({ stage: 'embedding' }).where('id', '=', job.id).execute();
      const embedding = await this.embedSnapshot(job.id, snapshotId);

      await this.assertNotCancelled(job.id);
      await this.finalize(job.id, repo, snapshotId, commitSha, {
        filesTotal: fetched.files.length + fetched.skipped.length,
        reused,
        failed,
        truncated: fetched.truncated,
        skipped: fetched.skipped.length,
        embedding,
      });
    } catch (err) {
      const retry = !opts.finalAttempt && !(err instanceof IndexingCancelled) && !(err instanceof IndexingFailure) && isTransient(err);
      if (retry) {
        await this.requeue(job.id, snapshotId, err);
        throw err; // BullMQ schedules the retry with backoff
      }
      await this.fail(job.id, job.repository_id, snapshotId, err);
    }
  }

  private async loadRepository(repositoryId: string, organizationId: string): Promise<RepoWithInstallation | undefined> {
    // Tenant scope from the job is re-validated against the parent record (DATABASE §7).
    return this.database.db
      .selectFrom('repositories as r')
      .leftJoin('git_installations as i', 'i.id', 'r.installation_id')
      .selectAll('r')
      .select(['i.external_installation_id', 'i.status as installation_status'])
      .where('r.id', '=', repositoryId)
      .where('r.organization_id', '=', organizationId)
      .executeTakeFirst();
  }

  private async processFile(
    repo: Repository,
    f: SourceFile,
    excludes: readonly string[],
    maxFileBytes: number,
    baseFiles: Map<string, { id: string; content_hash: string }>,
  ): Promise<FileRecord> {
    const lang = detectLanguage(f.path);
    const rec: FileRecord = {
      path: f.path,
      byteSize: f.size,
      contentHash: 'unread',
      language: lang.language === 'unknown' ? null : lang.language,
      fileType: lang.fileType,
      lineCount: null,
      excluded: false,
      exclusionReason: null,
      parseStatus: 'not_parsed',
    };
    const byPath = classifyPath(f.path, excludes);
    if (byPath.excluded) return { ...rec, excluded: true, exclusionReason: byPath.reason!, parseStatus: 'excluded' };
    const bytes = f.read();
    if (!bytes) return { ...rec, excluded: true, exclusionReason: 'too_large', parseStatus: 'excluded' };
    rec.contentHash = `sha256:${sha256Hex(bytes)}`;
    const byContent = classifyContent(bytes, maxFileBytes);
    // Secret-bearing files: only the decision is stored — never the content or the matched value.
    if (byContent.excluded) return { ...rec, excluded: true, exclusionReason: byContent.reason!, parseStatus: 'excluded' };
    rec.lineCount = byContent.lineCount ?? null;

    const prior = baseFiles.get(f.path);
    if (prior && prior.content_hash === rec.contentHash) {
      return { ...rec, parseStatus: lang.parser ? 'parsed' : 'unsupported_language', reuseFromFileId: prior.id };
    }

    rec.text = byContent.text!;
    const key = blobKey(repo.id, rec.contentHash);
    if (!(await this.storage.exists(key))) await this.storage.put(key, bytes);
    if (!lang.parser) return { ...rec, parseStatus: 'unsupported_language' };
    try {
      const parsed = await this.parser.parse(lang.parser, f.path, rec.text, rec.lineCount ?? 0);
      return { ...rec, parse: parsed, parseStatus: parsed.ok ? 'parsed' : 'parse_error' };
    } catch (err) {
      log.warn({ path: f.path, err: (err as Error).message }, 'parse failed');
      return { ...rec, parseStatus: 'parse_error' };
    }
  }

  private async persistBatch(tx: Tx, repo: Repository, snapshotId: string, records: FileRecord[]): Promise<void> {
    if (records.length === 0) return;
    const inserted = await tx
      .insertInto('repository_files')
      .values(
        records.map((r) => ({
          snapshot_id: snapshotId,
          repository_id: repo.id,
          path: r.path,
          content_hash: r.contentHash,
          language: r.language,
          file_type: r.fileType,
          byte_size: r.byteSize,
          line_count: r.lineCount,
          is_excluded: r.excluded,
          exclusion_reason: r.exclusionReason,
          parse_status: r.parseStatus,
        })),
      )
      .returning(['id', 'path'])
      .execute();
    const idByPath = new Map(inserted.map((r) => [r.path, r.id]));

    const reusePairs = records.filter((r) => r.reuseFromFileId).map((r) => [idByPath.get(r.path)!, r.reuseFromFileId!] as const);
    if (reusePairs.length > 0) await this.copyFromBase(tx, snapshotId, reusePairs);

    for (const r of records) {
      if (r.excluded || r.reuseFromFileId || r.text === undefined) continue;
      const fileId = idByPath.get(r.path)!;
      const symbols = r.parse?.symbols ?? [];
      const chunks = chunkFile(
        r.text,
        symbols.filter((s) => s.kind !== 'module'),
      );
      if (chunks.length > 0) {
        await tx
          .insertInto('code_chunks')
          .values(
            chunks.map((c) => ({
              repository_file_id: fileId,
              repository_id: repo.id,
              snapshot_id: snapshotId,
              chunk_index: c.index,
              start_line: c.startLine,
              end_line: c.endLine,
              symbol_name: c.symbolName,
              chunk_kind: c.kind,
              content: c.content,
              content_hash: `sha256:${sha256Hex(c.content)}`,
              language: r.language,
            })),
          )
          .execute();
      }
      if (symbols.length > 0) {
        const symRows = await tx
          .insertInto('symbols')
          .values(
            symbols.map((s) => ({
              repository_id: repo.id,
              snapshot_id: snapshotId,
              repository_file_id: fileId,
              symbol_key: s.key,
              name: s.name,
              qualified_name: s.qualifiedName,
              kind: s.kind,
              start_line: s.startLine,
              end_line: s.endLine,
              language: r.language,
              signature: s.signature,
            })),
          )
          .onConflict((oc) => oc.columns(['snapshot_id', 'symbol_key']).doNothing())
          .returning(['id', 'symbol_key'])
          .execute();
        const symId = new Map(symRows.map((s) => [s.symbol_key, s.id]));
        const rels = (r.parse?.relations ?? []).filter((rel) => symId.has(rel.sourceKey));
        for (let i = 0; i < rels.length; i += 1000) {
          await tx
            .insertInto('symbol_relationships')
            .values(
              rels.slice(i, i + 1000).map((rel) => ({
                snapshot_id: snapshotId,
                source_symbol_id: symId.get(rel.sourceKey)!,
                relationship_type: rel.type,
                target_external_name: rel.targetName,
                evidence: json({ path: r.path, line: rel.line }),
              })),
            )
            .execute();
        }
      }
    }
  }

  /** Copies chunks (with embeddings), symbols and relationships for unchanged files. */
  private async copyFromBase(tx: Tx, snapshotId: string, pairs: ReadonlyArray<readonly [string, string]>): Promise<void> {
    const newIds = pairs.map((p) => p[0]);
    const baseIds = pairs.map((p) => p[1]);
    await sql`
      INSERT INTO code_chunks (repository_file_id, repository_id, snapshot_id, chunk_index, start_line, end_line, symbol_name, chunk_kind, content, content_hash, language, embedding, embedding_model, embedding_version)
      SELECT m.new_id, c.repository_id, ${snapshotId}::uuid, c.chunk_index, c.start_line, c.end_line, c.symbol_name, c.chunk_kind, c.content, c.content_hash, c.language, c.embedding, c.embedding_model, c.embedding_version
      FROM unnest(${newIds}::uuid[], ${baseIds}::uuid[]) AS m(new_id, base_id)
      JOIN code_chunks c ON c.repository_file_id = m.base_id`.execute(tx);
    await sql`
      INSERT INTO symbols (repository_id, snapshot_id, repository_file_id, symbol_key, name, qualified_name, kind, start_line, end_line, language, signature)
      SELECT s.repository_id, ${snapshotId}::uuid, m.new_id, s.symbol_key, s.name, s.qualified_name, s.kind, s.start_line, s.end_line, s.language, s.signature
      FROM unnest(${newIds}::uuid[], ${baseIds}::uuid[]) AS m(new_id, base_id)
      JOIN symbols s ON s.repository_file_id = m.base_id
      ON CONFLICT (snapshot_id, symbol_key) DO NOTHING`.execute(tx);
    await sql`
      INSERT INTO symbol_relationships (snapshot_id, source_symbol_id, relationship_type, target_external_name, evidence)
      SELECT ${snapshotId}::uuid, ns.id, r.relationship_type, r.target_external_name, r.evidence
      FROM symbol_relationships r
      JOIN symbols os ON os.id = r.source_symbol_id
      JOIN symbols ns ON ns.snapshot_id = ${snapshotId}::uuid AND ns.symbol_key = os.symbol_key
      WHERE os.repository_file_id = ANY(${baseIds}::uuid[])`.execute(tx);
  }

  /** Links relationship targets to symbols when the name is unambiguous within the snapshot. */
  private async resolveRelationships(snapshotId: string): Promise<void> {
    await sql`
      UPDATE symbol_relationships r SET target_symbol_id = u.id
      FROM (
        SELECT name, (array_agg(id))[1] AS id FROM symbols
        WHERE snapshot_id = ${snapshotId}::uuid AND kind <> 'module'
        GROUP BY name HAVING count(*) = 1
      ) u
      WHERE r.snapshot_id = ${snapshotId}::uuid AND r.target_symbol_id IS NULL
        AND r.relationship_type IN ('calls', 'extends', 'instantiates')
        AND r.target_external_name = u.name`.execute(this.database.db);
  }

  /**
   * Embeds chunks lacking vectors. Never mixes embedding models within a
   * snapshot: reused vectors from another model/version are cleared first.
   */
  private async embedSnapshot(jobId: string, snapshotId: string): Promise<{ complete: boolean; model: string | null; error: string | null }> {
    const db = this.database.db;
    let model: string | null = null;
    let version: string | null = null;
    let dimension: number | null = null;
    let embedded = 0;
    try {
      const probe = await this.ai.embed(['anvaya embedding model probe'], 'document');
      model = probe.model;
      version = probe.model_version;
      dimension = probe.dimension;
      await db
        .updateTable('code_chunks')
        .set({ embedding: null, embedding_model: null, embedding_version: null })
        .where('snapshot_id', '=', snapshotId)
        .where('embedding', 'is not', null)
        .where((eb) => eb.or([eb('embedding_model', '!=', model!), eb('embedding_version', '!=', version!)]))
        .execute();

      for (;;) {
        await this.assertNotCancelled(jobId);
        const batch = await db
          .selectFrom('code_chunks as c')
          .innerJoin('repository_files as f', 'f.id', 'c.repository_file_id')
          .select(['c.id', 'c.content', 'c.symbol_name', 'f.path'])
          .where('c.snapshot_id', '=', snapshotId)
          .where('c.embedding', 'is', null)
          .orderBy('c.id')
          .limit(INDEX_LIMITS.embedBatch)
          .execute();
        if (batch.length === 0) break;
        const res = await this.ai.embed(
          batch.map((c) => embeddingText(c.path, { symbolName: c.symbol_name, content: c.content })),
          'document',
        );
        if (res.model !== model || res.model_version !== version) throw new AiServiceError('EMBEDDING_MODEL_CHANGED', 'embedding model changed during indexing', 409, true);
        await this.database.transaction(async (tx) => {
          for (let i = 0; i < batch.length; i++) {
            await tx
              .updateTable('code_chunks')
              .set({ embedding: `[${res.embeddings[i]!.join(',')}]`, embedding_model: model, embedding_version: version })
              .where('id', '=', batch[i]!.id)
              .execute();
          }
        });
        embedded += batch.length;
        await db.updateTable('indexing_jobs').set({ progress: sql`progress || ${json({ chunks_embedded: embedded })}::jsonb` }).where('id', '=', jobId).execute();
      }
      await db.updateTable('repository_snapshots').set({ embedding_model: `${model}@${version}`, embedding_dimension: dimension }).where('id', '=', snapshotId).execute();
      return { complete: true, model, error: null };
    } catch (err) {
      if (err instanceof IndexingCancelled) throw err;
      const code = err instanceof AiServiceError ? err.code : 'EMBEDDING_FAILED';
      log.warn({ snapshot_id: snapshotId, code }, 'embedding incomplete; snapshot remains lexically searchable');
      if (model) await db.updateTable('repository_snapshots').set({ embedding_model: `${model}@${version}`, embedding_dimension: dimension }).where('id', '=', snapshotId).execute();
      return { complete: false, model, error: code };
    }
  }

  private async finalize(
    jobId: string,
    repo: Repository,
    snapshotId: string,
    commitSha: string,
    info: { filesTotal: number; reused: number; failed: number; truncated: boolean; skipped: number; embedding: { complete: boolean; error: string | null } },
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const counts = await tx
        .selectFrom('repository_files')
        .select([
          sql<number>`count(*) FILTER (WHERE NOT is_excluded)::int`.as('indexed'),
          sql<number>`count(*) FILTER (WHERE is_excluded)::int`.as('excluded'),
        ])
        .where('snapshot_id', '=', snapshotId)
        .executeTakeFirstOrThrow();
      const langRows = await tx
        .selectFrom('repository_files')
        .select(['language', sql<number>`count(*)::int`.as('files'), sql<number>`count(*) FILTER (WHERE parse_status = 'parsed')::int`.as('parsed')])
        .where('snapshot_id', '=', snapshotId)
        .where('is_excluded', '=', false)
        .groupBy('language')
        .execute();
      const languageStats = Object.fromEntries(langRows.map((r) => [r.language ?? 'unknown', { files: r.files, parsed: r.parsed }]));
      const partial = info.failed > 0 || info.truncated || !info.embedding.complete;
      const status = partial ? 'partial' : 'ready';
      const notes = [
        info.truncated ? `file limit reached (${INDEX_LIMITS.maxFiles}); remaining files were not indexed` : null,
        info.failed > 0 ? `${info.failed} file(s) failed to parse` : null,
        !info.embedding.complete ? `embeddings incomplete (${info.embedding.error}); semantic search unavailable for some chunks` : null,
      ].filter(Boolean);
      await tx
        .updateTable('repository_snapshots')
        .set({
          status,
          total_files: info.filesTotal,
          indexed_files: counts.indexed,
          excluded_files: counts.excluded + info.skipped,
          failed_files: info.failed,
          reused_files: info.reused,
          language_stats: json(languageStats),
          error_summary: notes.length > 0 ? notes.join('; ') : null,
          completed_at: new Date(),
        })
        .where('id', '=', snapshotId)
        .execute();
      await tx
        .updateTable('repositories')
        .set({ indexing_status: status, latest_indexed_commit_sha: commitSha, indexed_at: new Date() })
        .where('id', '=', repo.id)
        .where('status', '=', 'connected')
        .execute();
      await tx
        .updateTable('indexing_jobs')
        .set({ status: partial ? 'partial' : 'succeeded', stage: 'completed', ended_at: new Date(), error_code: info.embedding.error, error_summary: notes.join('; ') || null })
        .where('id', '=', jobId)
        .execute();
      await this.audit.record(
        { organizationId: repo.organization_id, actorUserId: null, actorType: 'worker', action: 'repository.indexed', resourceType: 'repository', resourceId: repo.id, metadata: { commit_sha: commitSha, status, reused_files: info.reused } },
        tx,
      );
    });
    log.info({ repository_id: repo.id, commit_sha: commitSha, reused: info.reused }, 'indexing completed');
    metrics.indexingJobs.inc({ outcome: info.failed > 0 || info.truncated || !info.embedding.complete ? 'partial' : 'succeeded' });
  }

  private async finishUnchanged(jobId: string, repo: Repository, snapshotId: string, status: 'ready' | 'partial', commitSha: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.updateTable('repositories').set({ indexing_status: status, latest_indexed_commit_sha: commitSha, indexed_at: new Date() }).where('id', '=', repo.id).execute();
      await tx
        .updateTable('indexing_jobs')
        .set({ status: status === 'ready' ? 'succeeded' : 'partial', stage: 'completed', snapshot_id: snapshotId, ended_at: new Date(), error_summary: 'commit already indexed' })
        .where('id', '=', jobId)
        .execute();
    });
  }

  private async assertNotCancelled(jobId: string): Promise<void> {
    const row = await this.database.db.selectFrom('indexing_jobs').select('status').where('id', '=', jobId).executeTakeFirst();
    if (!row || row.status === 'cancelled') throw new IndexingCancelled('indexing cancelled');
  }

  private async requeue(jobId: string, snapshotId: string | null, err: unknown): Promise<void> {
    log.warn({ indexing_job_id: jobId, err: (err as Error).message }, 'transient indexing failure; will retry');
    await this.database.transaction(async (tx) => {
      if (snapshotId) await tx.deleteFrom('repository_snapshots').where('id', '=', snapshotId).execute();
      await tx
        .updateTable('indexing_jobs')
        .set({ status: 'queued', stage: 'retry_scheduled', snapshot_id: null, error_code: 'TRANSIENT_ERROR', error_summary: 'A transient error occurred; retrying.' })
        .where('id', '=', jobId)
        .where('status', 'in', ['queued', 'running'])
        .execute();
    });
  }

  private async fail(jobId: string, repositoryId: string, snapshotId: string | null, err: unknown): Promise<void> {
    const cancelled = err instanceof IndexingCancelled;
    const code = cancelled ? 'CANCELLED' : err instanceof IndexingFailure ? err.code : err instanceof AiServiceError ? err.code : 'INDEXING_FAILED';
    const message = err instanceof IndexingFailure ? err.message : cancelled ? 'Indexing was cancelled.' : 'Indexing failed; see logs for details.';
    log.error({ indexing_job_id: jobId, code, err: cancelled ? undefined : (err as Error).message }, 'indexing failed');
    metrics.indexingJobs.inc({ outcome: cancelled ? 'cancelled' : 'failed' });
    await this.database.transaction(async (tx) => {
      if (snapshotId) await tx.updateTable('repository_snapshots').set({ status: 'failed', error_summary: message, completed_at: new Date() }).where('id', '=', snapshotId).execute();
      await tx
        .updateTable('indexing_jobs')
        .set({ ...(cancelled ? {} : { status: 'failed' as const }), error_code: code, error_summary: message, ended_at: new Date() })
        .where('id', '=', jobId)
        .where('status', 'in', ['queued', 'running', 'cancelled'])
        .execute();
      // Keep serving the previous good snapshot if there is one.
      await tx
        .updateTable('repositories')
        .set({ indexing_status: sql`CASE WHEN status <> 'connected' THEN 'disabled' WHEN latest_indexed_commit_sha IS NULL THEN 'failed' ELSE coalesce((SELECT s.status FROM repository_snapshots s WHERE s.repository_id = repositories.id AND s.commit_sha = repositories.latest_indexed_commit_sha AND s.status IN ('ready','partial') LIMIT 1), 'failed') END` })
        .where('id', '=', repositoryId)
        .execute();
    });
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof AiServiceError) return err.retryable;
  if ((err as { transient?: boolean }).transient) return true;
  const code = (err as { code?: string }).code;
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === '40001' || code === '40P01';
}
