import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { AppError, Errors } from '../common/errors.js';
import { Idempotent } from '../common/idempotency.js';
import { decodeCursor, paginationQuery, toPage, UuidParamPipe, ZodPipe } from '../common/http.js';
import { RateLimit } from '../common/rate-limit.js';
import { DatabaseService } from '../database/database.service.js';
import { beforeCursor, cursorUs } from '../database/keyset.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { queueIndexBody } from '../repositories/repositories.schemas.js';
import { escapeLike, RetrievalService } from '../retrieval/retrieval.service.js';
import { blobKey, ObjectStorage } from '../storage/object-storage.js';
import { AccessService } from '../workspaces/access.service.js';
import { normalizePath } from './classifier.js';
import { IndexingRequestsService } from './indexing-requests.service.js';

const snapshotParam = z.union([z.literal('latest'), z.string().regex(/^[0-9a-f]{40}$/)]).default('latest');

export const searchBody = z
  .object({
    query: z.string().trim().min(1).max(500),
    snapshot: snapshotParam,
    top_k: z.number().int().min(1).max(50).default(8),
    mode: z.enum(['hybrid', 'lexical', 'semantic']).default('hybrid'),
    filters: z
      .object({
        languages: z.array(z.string().min(1).max(40)).max(20).optional(),
        paths: z.array(z.string().min(1).max(300)).max(20).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const treeQuery = z.object({ snapshot: snapshotParam, path: z.string().max(1024).default('') });
export const fileQuery = z.object({
  snapshot: snapshotParam,
  /** Alias for `snapshot` with a full commit SHA (GAP-04). If both are sent they must agree. */
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  path: z.string().min(1).max(1024),
  start_line: z.coerce.number().int().min(1).optional(),
  end_line: z.coerce.number().int().min(1).optional(),
});
const MAX_FILE_LINES = 2000;

@Controller('repositories/:repositoryId')
export class IndexingController {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly requests: IndexingRequestsService,
    private readonly retrieval: RetrievalService,
    private readonly storage: ObjectStorage,
  ) {}

  /** Queue (re)indexing. Coalesces with an active job. 202 Accepted. */
  @Post('index')
  @HttpCode(202)
  @Idempotent()
  @RateLimit({ bucket: 'index', max: 30, windowSeconds: 3600 })
  async queue(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) id: string, @Body(new ZodPipe(queueIndexBody)) body: z.infer<typeof queueIndexBody>) {
    const { repository } = await this.access.requireRepository(user.id, id, 'member');
    const res = await this.database.transaction((tx) =>
      this.requests.request(tx, { organizationId: repository.organization_id, repositoryId: id, trigger: 'manual', ref: body.ref ?? null, requestedBy: user.id }),
    );
    await this.requests.dispatch([res]);
    const job = await this.database.db.selectFrom('indexing_jobs').select(['id', 'status', 'trigger', 'requested_ref', 'created_at']).where('id', '=', res.indexingJobId).executeTakeFirstOrThrow();
    return { indexing_job_id: job.id, status: job.status, trigger: job.trigger, requested_ref: job.requested_ref, coalesced: !res.created, created_at: job.created_at.toISOString() };
  }

  /** Index status, coverage and known limitations (FR-REP-009). */
  @Get('index-status')
  async status(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) id: string) {
    const { repository } = await this.access.requireRepository(user.id, id);
    const db = this.database.db;
    const latest = repository.latest_indexed_commit_sha
      ? await db.selectFrom('repository_snapshots').selectAll().where('repository_id', '=', id).where('commit_sha', '=', repository.latest_indexed_commit_sha).executeTakeFirst()
      : undefined;
    const jobs = await db.selectFrom('indexing_jobs').selectAll().where('repository_id', '=', id).orderBy('created_at', 'desc').limit(5).execute();
    const active = jobs.find((j) => j.status === 'queued' || j.status === 'running');
    const lastFinished = jobs.find((j) => !['queued', 'running'].includes(j.status));
    let coverage = null;
    if (latest) {
      const reasons = await db
        .selectFrom('repository_files')
        .select(['exclusion_reason', sql<number>`count(*)::int`.as('n')])
        .where('snapshot_id', '=', latest.id)
        .where('is_excluded', '=', true)
        .groupBy('exclusion_reason')
        .execute();
      const parse = await db
        .selectFrom('repository_files')
        .select(['parse_status', sql<number>`count(*)::int`.as('n')])
        .where('snapshot_id', '=', latest.id)
        .groupBy('parse_status')
        .execute();
      const chunks = await db
        .selectFrom('code_chunks')
        .select([sql<number>`count(*)::int`.as('total'), sql<number>`count(embedding)::int`.as('embedded')])
        .where('snapshot_id', '=', latest.id)
        .executeTakeFirstOrThrow();
      coverage = {
        total_files: latest.total_files,
        indexed_files: latest.indexed_files,
        excluded_files: latest.excluded_files,
        failed_files: latest.failed_files,
        reused_files: latest.reused_files,
        excluded_by_reason: Object.fromEntries(reasons.map((r) => [r.exclusion_reason ?? 'unknown', r.n])),
        parse_status: Object.fromEntries(parse.map((p) => [p.parse_status, p.n])),
        languages: latest.language_stats,
        chunks: chunks.total,
        embedded_chunks: chunks.embedded,
      };
    }
    const jobView = (j: (typeof jobs)[number]) => ({
      id: j.id,
      status: j.status,
      stage: j.stage,
      trigger: j.trigger,
      commit_sha: j.commit_sha,
      progress: j.progress,
      attempts: j.attempts,
      error_code: j.error_code,
      error_summary: j.error_summary,
      created_at: j.created_at.toISOString(),
      started_at: j.started_at?.toISOString() ?? null,
      ended_at: j.ended_at?.toISOString() ?? null,
    });
    return {
      repository_id: id,
      indexing_status: repository.indexing_status,
      latest_snapshot: latest
        ? {
            id: latest.id,
            commit_sha: latest.commit_sha,
            branch_name: latest.branch_name,
            status: latest.status,
            parser_version: latest.parser_version,
            chunker_version: latest.chunker_version,
            embedding_model: latest.embedding_model,
            limitations: latest.error_summary,
            completed_at: latest.completed_at?.toISOString() ?? null,
          }
        : null,
      coverage,
      active_job: active ? jobView(active) : null,
      last_job: lastFinished ? jobView(lastFinished) : null,
      supported_parsers: ['typescript', 'javascript', 'python'],
    };
  }

  @Get('snapshots')
  async snapshots(
    @CurrentUser() user: AuthUser,
    @Param('repositoryId', new UuidParamPipe('Repository')) id: string,
    @Query(new ZodPipe(paginationQuery)) q: z.infer<typeof paginationQuery>,
  ) {
    await this.access.requireRepository(user.id, id);
    const cursor = decodeCursor(q.cursor);
    let query = this.database.db.selectFrom('repository_snapshots').selectAll().select(cursorUs('created_at').as('cursor_us')).where('repository_id', '=', id);
    if (cursor) query = query.where(beforeCursor('created_at', 'id', cursor));
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.limit + 1).execute();
    return toPage(rows, q.limit, (s) => ({
      id: s.id,
      commit_sha: s.commit_sha,
      branch_name: s.branch_name,
      status: s.status,
      total_files: s.total_files,
      indexed_files: s.indexed_files,
      excluded_files: s.excluded_files,
      failed_files: s.failed_files,
      reused_files: s.reused_files,
      parser_version: s.parser_version,
      chunker_version: s.chunker_version,
      embedding_model: s.embedding_model,
      limitations: s.error_summary,
      created_at: s.created_at.toISOString(),
      completed_at: s.completed_at?.toISOString() ?? null,
    }));
  }

  /** Direct children of `path` in the indexed snapshot (bounded). */
  @Get('tree')
  async tree(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) id: string, @Query(new ZodPipe(treeQuery)) q: z.infer<typeof treeQuery>) {
    const { repository } = await this.access.requireRepository(user.id, id);
    const snap = await this.retrieval.resolveSnapshot(repository, q.snapshot);
    const dir = q.path === '' ? '' : normalizePath(q.path.replace(/\/+$/, ''));
    if (dir === null) throw Errors.validation({ issues: [{ path: 'path', message: 'invalid path', code: 'invalid_path' }] });
    const prefix = dir === '' ? '' : `${dir}/`;
    // Inlined as a literal (a validated integer) so SELECT/GROUP BY/ORDER BY are the identical expression.
    const offset = sql.lit(prefix.length + 1);
    const rows = await this.database.db
      .selectFrom('repository_files')
      .select([
        sql<string>`split_part(substr(path, ${offset}), '/', 1)`.as('name'),
        sql<boolean>`bool_or(position('/' in substr(path, ${offset})) > 0)`.as('is_dir'),
        sql<number>`count(*)::int`.as('file_count'),
        sql<string | null>`max(language)`.as('language'),
        sql<string | null>`max(parse_status)`.as('parse_status'),
        sql<boolean>`bool_and(is_excluded)`.as('excluded'),
        sql<string | null>`max(exclusion_reason)`.as('exclusion_reason'),
        sql<number | null>`max(byte_size)`.as('byte_size'),
        sql<number | null>`max(line_count)`.as('line_count'),
      ])
      .where('snapshot_id', '=', snap.id)
      .where('path', 'like', `${escapeLike(prefix)}%`)
      .groupBy(sql`split_part(substr(path, ${offset}), '/', 1)`)
      .orderBy(sql`bool_or(position('/' in substr(path, ${offset})) > 0)`, 'desc')
      .orderBy('name')
      .limit(1001)
      .execute();
    if (rows.length === 0 && dir !== '') throw Errors.notFound('Path');
    const entries = rows.slice(0, 1000).map((r) =>
      r.is_dir
        ? { type: 'directory' as const, name: r.name, path: `${prefix}${r.name}`, file_count: r.file_count }
        : {
            type: 'file' as const,
            name: r.name,
            path: `${prefix}${r.name}`,
            language: r.language,
            parse_status: r.parse_status,
            excluded: r.excluded,
            exclusion_reason: r.exclusion_reason,
            byte_size: r.byte_size,
            line_count: r.line_count,
          },
    );
    return { snapshot_id: snap.id, commit_sha: snap.commit_sha, path: dir, entries, truncated: rows.length > 1000 };
  }

  /** File content at the indexed commit, for citation viewing. Excluded files are never served. */
  @Get('files/content')
  async file(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) id: string, @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>) {
    const { repository } = await this.access.requireRepository(user.id, id);
    if (q.commit_sha && q.snapshot !== 'latest' && q.snapshot !== q.commit_sha) {
      throw Errors.validation({ issues: [{ path: 'commit_sha', message: 'must match snapshot when both are sent', code: 'invalid_value' }] });
    }
    const snap = await this.retrieval.resolveSnapshot(repository, q.commit_sha ?? q.snapshot);
    const path = normalizePath(q.path);
    if (!path) throw Errors.badRequest('The path is not a valid repository-relative path.');
    const f = await this.database.db
      .selectFrom('repository_files')
      .select(['path', 'content_hash', 'language', 'line_count', 'is_excluded', 'exclusion_reason', 'parse_status'])
      .where('snapshot_id', '=', snap.id)
      .where('path', '=', path)
      .executeTakeFirst();
    if (!f) throw Errors.notFound('File');
    if (f.is_excluded) throw new AppError(403, 'FILE_EXCLUDED', 'This file was excluded from indexing.', { reason: f.exclusion_reason });
    const blob = await this.storage.get(blobKey(id, f.content_hash));
    if (!blob) throw Errors.unavailable('CONTENT_UNAVAILABLE', 'File content is not available in storage.');
    const lines = blob.toString('utf8').split(/\r?\n/);
    const total = f.line_count ?? lines.length;
    const start = Math.min(q.start_line ?? 1, Math.max(1, total));
    const requestedEnd = q.end_line ?? total;
    if (requestedEnd < start) throw Errors.validation({ issues: [{ path: 'end_line', message: 'must be >= start_line', code: 'invalid_range' }] });
    const end = Math.min(requestedEnd, total, start + MAX_FILE_LINES - 1);
    return {
      path: f.path,
      commit_sha: snap.commit_sha,
      content_hash: f.content_hash,
      language: f.language,
      parse_status: f.parse_status,
      line_count: total,
      start_line: start,
      end_line: end,
      truncated: end < Math.min(requestedEnd, total),
      content: lines.slice(start - 1, end).join('\n'),
    };
  }

  @Post('search')
  @HttpCode(200)
  @RateLimit({ bucket: 'search', max: 120, windowSeconds: 60 })
  async search(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) id: string, @Body(new ZodPipe(searchBody)) body: z.infer<typeof searchBody>) {
    const { repository } = await this.access.requireRepository(user.id, id);
    const res = await this.retrieval.search(repository, { query: body.query, snapshot: body.snapshot, topK: body.top_k, filters: body.filters, mode: body.mode });
    return { results: res.results.map(({ content: _content, ...r }) => r), retrieval: res.retrieval };
  }
}
