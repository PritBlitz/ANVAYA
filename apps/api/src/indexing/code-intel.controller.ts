import { Controller, Get, Param, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { Errors } from '../common/errors.js';
import { Page, UuidParamPipe, ZodPipe } from '../common/http.js';
import { DatabaseService } from '../database/database.service.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { escapeLike, RetrievalService } from '../retrieval/retrieval.service.js';
import { AccessService } from '../workspaces/access.service.js';
import { normalizePath } from './classifier.js';
import { resolveImport } from './import-resolver.js';

const snapshotParam = z.union([z.literal('latest'), z.string().regex(/^[0-9a-f]{40}$/)]).default('latest');
export const SYMBOL_KINDS = ['function', 'class', 'method', 'type', 'interface', 'module'] as const;

export const symbolsQuery = z.object({
  snapshot: snapshotParam,
  /** Case-insensitive substring of the name or qualified name. */
  q: z.string().trim().min(1).max(200).optional(),
  kind: z.union([z.enum(SYMBOL_KINDS), z.array(z.enum(SYMBOL_KINDS)).max(6)]).optional(),
  /** File path, or a directory prefix ending in `/`. */
  path: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});
export const symbolDetailQuery = z.object({ snapshot: snapshotParam });
export const dependencyMapQuery = z.object({
  snapshot: snapshotParam,
  /** Restrict nodes to files under this directory (edges leaving it are still counted). */
  path: z.string().max(1024).optional(),
});

const MAX_REFS = 200;
const MAX_NODES = 2000;
const MAX_EDGES = 5000;

type SymbolRow = {
  id: string;
  name: string;
  qualified_name: string | null;
  kind: string;
  start_line: number;
  end_line: number;
  language: string | null;
  signature: string | null;
  path: string;
};

const symbolView = (s: SymbolRow) => ({
  id: s.id,
  name: s.name,
  qualified_name: s.qualified_name,
  kind: s.kind,
  path: s.path,
  start_line: s.start_line,
  end_line: s.end_line,
  language: s.language,
  signature: s.signature,
});

function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id])).toString('base64url');
}
function decodeSymbolCursor(c: string | undefined): [string, string] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && z.uuid().safeParse(v[1]).success) return [v[0], v[1]];
  } catch {
    /* fall through */
  }
  throw Errors.validation({ issues: [{ path: 'cursor', message: 'invalid cursor', code: 'invalid_cursor' }] });
}

/**
 * Code intelligence over an indexed snapshot (GAP-15, PRD §7.2): a symbol
 * explorer and a file-level dependency map. Read-only views of what the
 * indexer already parsed; nothing here executes or re-parses repository code.
 */
@Controller('repositories/:repositoryId')
export class CodeIntelController {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly retrieval: RetrievalService,
  ) {}

  private symbolsBase(snapshotId: string) {
    return this.database.db
      .selectFrom('symbols as s')
      .innerJoin('repository_files as f', 'f.id', 's.repository_file_id')
      .select(['s.id', 's.name', 's.qualified_name', 's.kind', 's.start_line', 's.end_line', 's.language', 's.signature', 'f.path'])
      .where('s.snapshot_id', '=', snapshotId)
      .where('f.is_excluded', '=', false);
  }

  @Get('symbols')
  async symbols(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) id: string, @Query(new ZodPipe(symbolsQuery)) q: z.infer<typeof symbolsQuery>) {
    const { repository } = await this.access.requireRepository(user.id, id);
    const snap = await this.retrieval.resolveSnapshot(repository, q.snapshot);
    let query = this.symbolsBase(snap.id);
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      query = query.where((eb) => eb.or([eb('s.name', 'ilike', like), eb('s.qualified_name', 'ilike', like)]));
    }
    if (q.kind) query = query.where('s.kind', 'in', Array.isArray(q.kind) ? q.kind : [q.kind]);
    if (q.path) {
      const dir = q.path.endsWith('/');
      const p = normalizePath(q.path.replace(/\/+$/, ''));
      if (!p) throw Errors.validation({ issues: [{ path: 'path', message: 'invalid path', code: 'invalid_path' }] });
      query = dir ? query.where('f.path', 'like', `${escapeLike(p)}/%`) : query.where('f.path', '=', p);
    }
    const cursor = decodeSymbolCursor(q.cursor);
    if (cursor) query = query.where(sql<boolean>`(s.name, s.id) > (${cursor[0]}, ${cursor[1]}::uuid)`);
    const rows = await query.orderBy('s.name').orderBy('s.id').limit(q.limit + 1).execute();
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return new Page(
      items.map((s) => ({ ...symbolView(s), snapshot_id: snap.id, commit_sha: snap.commit_sha })),
      rows.length > q.limit && last ? encodeCursor(last.name, last.id) : null,
    );
  }

  @Get('symbols/:symbolId')
  async symbol(
    @CurrentUser() user: AuthUser,
    @Param('repositoryId', new UuidParamPipe('Repository')) id: string,
    @Param('symbolId', new UuidParamPipe('Symbol')) symbolId: string,
    @Query(new ZodPipe(symbolDetailQuery)) q: z.infer<typeof symbolDetailQuery>,
  ) {
    const { repository } = await this.access.requireRepository(user.id, id);
    const snap = await this.retrieval.resolveSnapshot(repository, q.snapshot);
    const sym = await this.symbolsBase(snap.id).where('s.id', '=', symbolId).executeTakeFirst();
    if (!sym) throw Errors.notFound('Symbol');
    const db = this.database.db;
    const outgoing = await db
      .selectFrom('symbol_relationships as r')
      .leftJoin('symbols as t', 't.id', 'r.target_symbol_id')
      .leftJoin('repository_files as tf', 'tf.id', 't.repository_file_id')
      .select([
        'r.relationship_type',
        'r.target_external_name',
        'r.evidence',
        't.id as t_id',
        't.name as t_name',
        't.qualified_name as t_qualified_name',
        't.kind as t_kind',
        't.start_line as t_start_line',
        't.end_line as t_end_line',
        't.language as t_language',
        't.signature as t_signature',
        'tf.path as t_path',
        'tf.is_excluded as t_excluded',
      ])
      .where('r.snapshot_id', '=', snap.id)
      .where('r.source_symbol_id', '=', symbolId)
      .orderBy(sql`(r.evidence->>'line')::int`)
      .limit(MAX_REFS + 1)
      .execute();
    const incoming = await db
      .selectFrom('symbol_relationships as r')
      .innerJoin('symbols as s', 's.id', 'r.source_symbol_id')
      .innerJoin('repository_files as f', 'f.id', 's.repository_file_id')
      .select(['r.relationship_type', 'r.evidence', 's.id', 's.name', 's.qualified_name', 's.kind', 's.start_line', 's.end_line', 's.language', 's.signature', 'f.path'])
      .where('r.snapshot_id', '=', snap.id)
      .where('r.target_symbol_id', '=', symbolId)
      .where('f.is_excluded', '=', false)
      .orderBy('f.path')
      .orderBy(sql`(r.evidence->>'line')::int`)
      .limit(MAX_REFS + 1)
      .execute();
    const line = (e: unknown) => (e && typeof e === 'object' && typeof (e as { line?: unknown }).line === 'number' ? (e as { line: number }).line : null);
    return {
      snapshot_id: snap.id,
      commit_sha: snap.commit_sha,
      symbol: symbolView(sym),
      outgoing: outgoing.slice(0, MAX_REFS).map((r) => ({
        type: r.relationship_type,
        line: line(r.evidence),
        target:
          r.t_id && !r.t_excluded
            ? symbolView({
                id: r.t_id,
                name: r.t_name!,
                qualified_name: r.t_qualified_name,
                kind: r.t_kind!,
                start_line: r.t_start_line!,
                end_line: r.t_end_line!,
                language: r.t_language,
                signature: r.t_signature,
                path: r.t_path!,
              })
            : null,
        target_name: r.t_name ?? r.target_external_name,
      })),
      incoming: incoming.slice(0, MAX_REFS).map((r) => ({ type: r.relationship_type, line: line(r.evidence), source: symbolView(r) })),
      truncated: outgoing.length > MAX_REFS || incoming.length > MAX_REFS,
    };
  }

  /** File-level import graph with external packages aggregated. Edges are resolved from file paths only. */
  @Get('dependency-map')
  async dependencyMap(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) id: string, @Query(new ZodPipe(dependencyMapQuery)) q: z.infer<typeof dependencyMapQuery>) {
    const { repository } = await this.access.requireRepository(user.id, id);
    const snap = await this.retrieval.resolveSnapshot(repository, q.snapshot);
    let prefix = '';
    if (q.path && q.path.replace(/\/+$/, '') !== '') {
      const p = normalizePath(q.path.replace(/\/+$/, ''));
      if (!p) throw Errors.validation({ issues: [{ path: 'path', message: 'invalid path', code: 'invalid_path' }] });
      prefix = `${p}/`;
    }
    const db = this.database.db;
    const fileRows = await db
      .selectFrom('repository_files as f')
      .leftJoin('symbols as s', 's.repository_file_id', 'f.id')
      .select(['f.path', 'f.language', 'f.line_count', sql<number>`count(s.id)::int`.as('symbol_count')])
      .where('f.snapshot_id', '=', snap.id)
      .where('f.is_excluded', '=', false)
      .where('f.parse_status', '=', 'parsed')
      .groupBy(['f.path', 'f.language', 'f.line_count'])
      .execute();
    const files = new Set(fileRows.map((f) => f.path));
    const imports = await db
      .selectFrom('symbol_relationships as r')
      .innerJoin('symbols as s', 's.id', 'r.source_symbol_id')
      .innerJoin('repository_files as f', 'f.id', 's.repository_file_id')
      .select(['f.path', 'f.language', 'r.target_external_name', 'r.evidence'])
      .where('r.snapshot_id', '=', snap.id)
      .where('r.relationship_type', '=', 'imports')
      .where('f.is_excluded', '=', false)
      .execute();

    const inScope = (p: string) => prefix === '' || p.startsWith(prefix);
    const edges = new Map<string, { source: string; target: string; count: number; lines: number[] }>();
    const external = new Map<string, { name: string; count: number; importers: Set<string> }>();
    let unresolved = 0;
    for (const imp of imports) {
      if (!inScope(imp.path) || !imp.target_external_name) continue;
      const res = resolveImport(imp.path, imp.language, imp.target_external_name, files);
      const ln = (imp.evidence as { line?: number } | null)?.line;
      if (res.kind === 'internal') {
        if (res.path === imp.path) continue;
        const key = `${imp.path}\u0000${res.path}`;
        const e = edges.get(key) ?? { source: imp.path, target: res.path, count: 0, lines: [] };
        e.count++;
        if (typeof ln === 'number' && e.lines.length < 20) e.lines.push(ln);
        edges.set(key, e);
      } else if (res.kind === 'external') {
        const e = external.get(res.name) ?? { name: res.name, count: 0, importers: new Set<string>() };
        e.count++;
        e.importers.add(imp.path);
        external.set(res.name, e);
      } else unresolved++;
    }
    const allNodes = fileRows.filter((f) => inScope(f.path) || [...edges.values()].some((e) => e.target === f.path && inScope(e.source)));
    const nodes = allNodes.sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_NODES);
    const nodeSet = new Set(nodes.map((n) => n.path));
    const edgeList = [...edges.values()].filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target)).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
    const fanIn = new Map<string, number>();
    const fanOut = new Map<string, number>();
    for (const e of edgeList) {
      fanOut.set(e.source, (fanOut.get(e.source) ?? 0) + 1);
      fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1);
    }
    return {
      snapshot_id: snap.id,
      commit_sha: snap.commit_sha,
      path: prefix.replace(/\/$/, ''),
      nodes: nodes.map((n) => ({
        path: n.path,
        language: n.language,
        line_count: n.line_count,
        symbol_count: n.symbol_count,
        imports: fanOut.get(n.path) ?? 0,
        imported_by: fanIn.get(n.path) ?? 0,
        in_scope: inScope(n.path),
      })),
      edges: edgeList.slice(0, MAX_EDGES),
      external: [...external.values()]
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 500)
        .map((e) => ({ name: e.name, count: e.count, importer_count: e.importers.size })),
      unresolved_imports: unresolved,
      truncated: allNodes.length > MAX_NODES || edgeList.length > MAX_EDGES,
      limitations: ['Path aliases (tsconfig paths, package exports) are not resolved.', 'Dynamic imports with computed specifiers are not recorded.'],
    };
  }
}
