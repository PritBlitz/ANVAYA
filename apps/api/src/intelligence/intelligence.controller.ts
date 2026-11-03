import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Errors } from '../common/errors.js';
import { UuidParamPipe, ZodPipe } from '../common/http.js';
import { RateLimit } from '../common/rate-limit.js';
import { DatabaseService } from '../database/database.service.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { normalizePath } from '../indexing/classifier.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { AccessService } from '../workspaces/access.service.js';
import { callGraph, IMPACT_DISCLAIMER, IMPACT_LIMITATIONS } from './graph.js';
import { ImpactService } from './impact.service.js';
import { WorkspaceKnowledgeService, workspaceAskBody, workspaceSearchBody } from './workspace-knowledge.service.js';

const snapshotParam = z.union([z.literal('latest'), z.string().regex(/^[0-9a-f]{40}$/)]).default('latest');
const MAX_CALL_GRAPH_NODES = 500;

export const callGraphQuery = z.object({
  snapshot: snapshotParam,
  direction: z.enum(['callers', 'callees', 'both']).default('both'),
  depth: z.coerce.number().int().min(1).max(3).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(64).optional(),
});

const changedFileInput = z.union([
  z.string().min(1).max(1024),
  z
    .object({
      path: z.string().min(1).max(1024),
      ranges: z
        .array(z.tuple([z.number().int().min(1), z.number().int().min(1)]))
        .max(200)
        .optional(),
    })
    .strict(),
]);

export const impactBody = z
  .object({
    snapshot: snapshotParam,
    changed_files: z.array(changedFileInput).min(1).max(200),
    max_tests: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const runImpactQuery = z.object({ max_tests: z.coerce.number().int().min(1).max(100).default(20) });

function decodeOffset(c: string | undefined): number {
  if (!c) return 0;
  const n = Number(Buffer.from(c, 'base64url').toString('utf8'));
  if (!Number.isInteger(n) || n < 0 || n > MAX_CALL_GRAPH_NODES) throw Errors.validation({ issues: [{ path: 'cursor', message: 'invalid cursor', code: 'invalid_cursor' }] });
  return n;
}
const encodeOffset = (n: number) => Buffer.from(String(n)).toString('base64url');

/**
 * Advanced code intelligence (releases/V1.md work package B): call graph, change-impact
 * prediction with test selection, and workspace-wide knowledge search / Q&A. All read-only;
 * nothing here executes repository code. Impact results are labelled heuristic (FR-VER-006).
 */
@Controller()
export class IntelligenceController {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly retrieval: RetrievalService,
    private readonly impact: ImpactService,
    private readonly workspace: WorkspaceKnowledgeService,
  ) {}

  /** Callers and/or callees of a symbol from name-resolved call edges; bounded depth, offset-paged nodes. */
  @Get('repositories/:repositoryId/symbols/:symbolId/call-graph')
  async callGraph(
    @CurrentUser() user: AuthUser,
    @Param('repositoryId', new UuidParamPipe('Repository')) repositoryId: string,
    @Param('symbolId', new UuidParamPipe('Symbol')) symbolId: string,
    @Query(new ZodPipe(callGraphQuery)) q: z.infer<typeof callGraphQuery>,
  ) {
    const { repository } = await this.access.requireRepository(user.id, repositoryId);
    const snap = await this.retrieval.resolveSnapshot(repository, q.snapshot);
    const graph = await this.impact.loadGraph(snap.id, { imports: false });
    const root = graph.symbols.get(symbolId);
    if (!root) throw Errors.notFound('Symbol');
    const offset = decodeOffset(q.cursor);
    const g = callGraph(graph, symbolId, q.direction, q.depth, MAX_CALL_GRAPH_NODES);
    const page = g.nodes.slice(offset, offset + q.limit);
    const pageIds = new Set(page.map((n) => n.symbol.id));
    const unresolved =
      offset === 0 && q.direction !== 'callers'
        ? await this.database.db
            .selectFrom('symbol_relationships')
            .select(['target_external_name', 'relationship_type', 'evidence'])
            .where('snapshot_id', '=', snap.id)
            .where('source_symbol_id', '=', symbolId)
            .where('relationship_type', 'in', ['calls', 'instantiates'])
            .where('target_symbol_id', 'is', null)
            .limit(100)
            .execute()
        : [];
    const ln = (e: unknown) => (e && typeof e === 'object' && typeof (e as { line?: unknown }).line === 'number' ? (e as { line: number }).line : null);
    return {
      snapshot_id: snap.id,
      commit_sha: snap.commit_sha,
      root,
      direction: q.direction,
      depth: q.depth,
      nodes: page,
      edges: g.edges.filter((e) => pageIds.has(e.source_id) || pageIds.has(e.target_id)),
      unresolved_callees: unresolved
        .map((u) => ({ name: u.target_external_name ?? '', type: u.relationship_type, line: ln(u.evidence) }))
        .filter((u) => u.name !== '')
        .sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.name.localeCompare(b.name)),
      total_nodes: g.nodes.length,
      next_cursor: offset + q.limit < g.nodes.length ? encodeOffset(offset + q.limit) : null,
      truncated: g.truncated,
      limitations: [
        'Calls are linked only when the callee name is unambiguous in the snapshot; others are listed as unresolved.',
        'Dynamic dispatch, callbacks, decorators and reflection are not followed.',
        `At most ${MAX_CALL_GRAPH_NODES} symbols are returned for one graph.`,
      ],
    };
  }

  /** Predicted impact and test selection for a set of changed files at an indexed snapshot. */
  @Post('repositories/:repositoryId/impact')
  @HttpCode(200)
  @RateLimit({ bucket: 'impact', max: 60, windowSeconds: 60 })
  async predict(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) repositoryId: string, @Body(new ZodPipe(impactBody)) body: z.infer<typeof impactBody>) {
    const { repository } = await this.access.requireRepository(user.id, repositoryId);
    const snap = await this.retrieval.resolveSnapshot(repository, body.snapshot);
    const changed = body.changed_files.map((c) => {
      const raw = typeof c === 'string' ? { path: c } : c;
      const path = normalizePath(raw.path);
      if (!path) throw Errors.validation({ issues: [{ path: 'changed_files', message: `invalid path: ${raw.path.slice(0, 100)}`, code: 'invalid_path' }] });
      return { path, ...(raw.ranges ? { ranges: raw.ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]) } : {}) };
    });
    const result = await this.impact.predict(snap.id, changed, body.max_tests);
    return { snapshot_id: snap.id, commit_sha: snap.commit_sha, source: 'request', disclaimer: IMPACT_DISCLAIMER, ...result };
  }

  /** Impact of a run's latest patch (or, before one exists, of its plan's files). */
  @Get('runs/:runId/impact')
  async runImpact(@CurrentUser() user: AuthUser, @Param('runId', new UuidParamPipe('Run')) runId: string, @Query(new ZodPipe(runImpactQuery)) q: z.infer<typeof runImpactQuery>) {
    const { run } = await this.access.requireRun(user.id, runId);
    const snap = run.snapshot_id ? await this.database.db.selectFrom('repository_snapshots').select(['id', 'commit_sha', 'status']).where('id', '=', run.snapshot_id).executeTakeFirst() : undefined;
    const changes = await this.impact.runChanges(run);
    const selection = await this.database.db
      .selectFrom('verification_runs')
      .select(['profile_id', 'attempt', 'test_selection'])
      .where('run_id', '=', runId)
      .where('test_selection', 'is not', null)
      .orderBy('created_at')
      .execute();
    const base = { run_id: runId, source: changes.source, patch_id: changes.patch_id, plan_version: changes.plan_version, disclaimer: IMPACT_DISCLAIMER, applied_selections: selection.map((s) => ({ profile_id: s.profile_id, attempt: s.attempt, selection: s.test_selection })) };
    if (!snap || !['ready', 'partial'].includes(snap.status) || changes.changed.length === 0) {
      return {
        ...base,
        snapshot_id: snap?.id ?? null,
        commit_sha: snap?.commit_sha ?? null,
        heuristic: true as const,
        changed_files: [],
        changed_symbols: [],
        impacted_files: [],
        impacted_symbols: [],
        selected_tests: [],
        test_files_total: 0,
        truncated: false,
        limitations: [...IMPACT_LIMITATIONS, !snap ? 'The run has no indexed snapshot to analyse.' : 'Nothing to analyse yet: the run has no plan files or patch.'],
      };
    }
    const result = await this.impact.predict(snap.id, changes.changed, q.max_tests);
    return { ...base, snapshot_id: snap.id, commit_sha: snap.commit_sha, ...result };
  }

  /** Workspace-wide search across every indexed repository the caller can access, with provenance. */
  @Post('workspaces/:workspaceId/search')
  @HttpCode(200)
  @RateLimit({ bucket: 'search', max: 120, windowSeconds: 60 })
  search(@CurrentUser() user: AuthUser, @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string, @Body(new ZodPipe(workspaceSearchBody)) body: z.infer<typeof workspaceSearchBody>) {
    return this.workspace.search(user.id, workspaceId, body);
  }

  /** Grounded Q&A over evidence from all of the workspace's indexed repositories. */
  @Post('workspaces/:workspaceId/questions')
  @HttpCode(200)
  @RateLimit({ bucket: 'ai', max: 30, windowSeconds: 60 })
  ask(@CurrentUser() user: AuthUser, @Param('workspaceId', new UuidParamPipe('Workspace')) workspaceId: string, @Body(new ZodPipe(workspaceAskBody)) body: z.infer<typeof workspaceAskBody>) {
    return this.workspace.ask(user.id, workspaceId, body);
  }
}
