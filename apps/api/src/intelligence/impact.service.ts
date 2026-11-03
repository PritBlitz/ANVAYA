import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import type { WorkflowRun } from '../database/types.js';
import { normalizePath } from '../indexing/classifier.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { resolveImport } from '../indexing/import-resolver.js';
import { type CallEdge, type ChangedFile, changedRangesFromDiff, type CodeGraph, type ImpactResult, type ImportEdge, predictImpact, type SymbolInfo } from './graph.js';

export type RunImpactSource = 'patch' | 'plan' | 'none';

const line = (e: unknown): number | null => (e && typeof e === 'object' && typeof (e as { line?: unknown }).line === 'number' ? (e as { line: number }).line : null);

/**
 * Loads the parsed code graph of one snapshot (non-excluded files only) and runs the static
 * impact/test-selection heuristic over it. Callers must have authorized access to the snapshot's
 * repository. Bounded by the indexer's own caps (symbols/relations per file).
 */
@Injectable()
export class ImpactService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: ObjectStorage,
  ) {}

  async loadGraph(snapshotId: string, opts: { imports?: boolean } = {}): Promise<CodeGraph> {
    const db = this.database.db;
    const [fileRows, symbolRows, callRows, importRows] = await Promise.all([
      db.selectFrom('repository_files').select(['path']).where('snapshot_id', '=', snapshotId).where('is_excluded', '=', false).execute(),
      db
        .selectFrom('symbols as s')
        .innerJoin('repository_files as f', 'f.id', 's.repository_file_id')
        .select(['s.id', 's.name', 's.qualified_name', 's.kind', 's.start_line', 's.end_line', 'f.path'])
        .where('s.snapshot_id', '=', snapshotId)
        .where('f.is_excluded', '=', false)
        .execute(),
      db
        .selectFrom('symbol_relationships')
        .select(['source_symbol_id', 'target_symbol_id', 'relationship_type', 'evidence'])
        .where('snapshot_id', '=', snapshotId)
        .where('relationship_type', 'in', ['calls', 'instantiates'])
        .where('target_symbol_id', 'is not', null)
        .execute(),
      opts.imports === false
        ? Promise.resolve([])
        : db
            .selectFrom('symbol_relationships as r')
            .innerJoin('symbols as s', 's.id', 'r.source_symbol_id')
            .innerJoin('repository_files as f', 'f.id', 's.repository_file_id')
            .select(['f.path', 'f.language', 'r.target_external_name', 'r.evidence'])
            .where('r.snapshot_id', '=', snapshotId)
            .where('r.relationship_type', '=', 'imports')
            .where('f.is_excluded', '=', false)
            .orderBy('f.path')
            .orderBy(sql`(r.evidence->>'line')::int`)
            .execute(),
    ]);
    const files = new Set(fileRows.map((f) => f.path));
    const symbols = new Map<string, SymbolInfo>(symbolRows.map((s) => [s.id, { id: s.id, name: s.name, qualified_name: s.qualified_name, kind: s.kind, path: s.path, start_line: s.start_line, end_line: s.end_line }]));
    const calls: CallEdge[] = callRows
      .filter((r) => r.target_symbol_id !== null && symbols.has(r.source_symbol_id) && symbols.has(r.target_symbol_id))
      .map((r) => ({ source_symbol_id: r.source_symbol_id, target_symbol_id: r.target_symbol_id!, type: r.relationship_type, line: line(r.evidence) }));
    const imports: ImportEdge[] = [];
    for (const r of importRows) {
      if (!r.target_external_name) continue;
      const res = resolveImport(r.path, r.language, r.target_external_name, files);
      if (res.kind === 'internal' && res.path !== r.path) imports.push({ from: r.path, to: res.path, line: line(r.evidence) });
    }
    return { files, imports, symbols, calls };
  }

  async predict(snapshotId: string, changed: ChangedFile[], maxTests = 20): Promise<ImpactResult> {
    return predictImpact(await this.loadGraph(snapshotId), changed, { maxTests });
  }

  /**
   * What a run changes, for impact prediction: the latest applied patch (with old-side line ranges
   * from its diff) or, before any patch exists, the files its latest plan intends to modify.
   */
  async runChanges(run: Pick<WorkflowRun, 'id'>): Promise<{ source: RunImpactSource; patch_id: string | null; plan_version: number | null; changed: ChangedFile[] }> {
    const db = this.database.db;
    const patch = await db.selectFrom('patches').select(['id', 'patch_object_key', 'files_object_key']).where('run_id', '=', run.id).where('status', '=', 'applied').orderBy('attempt', 'desc').limit(1).executeTakeFirst();
    if (patch) {
      const filesRaw = patch.files_object_key ? await this.storage.get(patch.files_object_key) : null;
      const files = parseFiles(filesRaw?.toString('utf8'));
      const ranges = changedRangesFromDiff((await this.storage.get(patch.patch_object_key))?.toString('utf8') ?? '');
      const changed = files.map((f) => ({ path: f.path, ...(f.before === null ? { ranges: [] as Array<[number, number]> } : ranges.has(f.path) ? { ranges: ranges.get(f.path)! } : {}) }));
      return { source: 'patch', patch_id: patch.id, plan_version: null, changed };
    }
    const plan = await db.selectFrom('run_plans').select(['version', 'content']).where('run_id', '=', run.id).orderBy('version', 'desc').limit(1).executeTakeFirst();
    const files = (plan?.content as { files_to_modify?: unknown } | undefined)?.files_to_modify;
    if (plan && Array.isArray(files) && files.length > 0) {
      const changed = [...new Set(files.filter((f): f is string => typeof f === 'string').map((f) => normalizePath(f)).filter((f): f is string => f !== null))].map((path) => ({ path }));
      return { source: 'plan', patch_id: null, plan_version: plan.version, changed };
    }
    return { source: 'none', patch_id: null, plan_version: null, changed: [] };
  }
}

function parseFiles(text: string | undefined): Array<{ path: string; before: string | null }> {
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    if (!Array.isArray(v)) return [];
    return v.flatMap((f: unknown) => {
      const r = f as { path?: unknown; before?: unknown };
      const p = typeof r.path === 'string' ? normalizePath(r.path) : null;
      return p ? [{ path: p, before: typeof r.before === 'string' ? r.before : null }] : [];
    });
  } catch {
    return [];
  }
}
