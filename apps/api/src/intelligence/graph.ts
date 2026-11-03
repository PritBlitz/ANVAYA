/**
 * Static change-impact prediction and test selection (releases/V1.md work package B).
 *
 * Pure functions over what the indexer already parsed: file-level imports (resolved by path,
 * see import-resolver.ts) and name-resolved call/instantiation edges. Nothing here executes or
 * re-parses repository code. Every result is a HEURISTIC with the evidence chain that produced
 * it; it is never a verification result and never implies correctness (FR-VER-006).
 */

export interface ImportEdge {
  from: string;
  to: string;
  line: number | null;
}

export interface SymbolInfo {
  id: string;
  name: string;
  qualified_name: string | null;
  kind: string;
  path: string;
  start_line: number;
  end_line: number;
}

export interface CallEdge {
  source_symbol_id: string;
  target_symbol_id: string;
  type: string;
  line: number | null;
}

export interface CodeGraph {
  files: ReadonlySet<string>;
  imports: readonly ImportEdge[];
  symbols: ReadonlyMap<string, SymbolInfo>;
  calls: readonly CallEdge[];
}

export interface ChangedFile {
  path: string;
  /** Line ranges changed in the snapshot (old-side) version of the file; absent = whole file. */
  ranges?: Array<[number, number]>;
}

export type EvidenceStep =
  | { kind: 'imports'; from: string; to: string; line: number | null }
  | { kind: 'calls'; from: string; to: string; line: number | null; caller: string; callee: string }
  | { kind: 'changed'; path: string }
  | { kind: 'naming'; from: string; to: string };

export interface ImpactedFile {
  path: string;
  distance: number;
  reason: 'imports' | 'calls';
  evidence: EvidenceStep[];
}

export interface ImpactedSymbol {
  symbol: SymbolInfo;
  depth: number;
  evidence: EvidenceStep[];
}

export interface SelectedTest {
  path: string;
  score: number;
  reasons: Array<{ kind: 'changed' | 'imports' | 'calls' | 'naming'; description: string; evidence: EvidenceStep[] }>;
}

export interface ImpactResult {
  heuristic: true;
  changed_files: Array<{ path: string; indexed: boolean; symbols: number }>;
  changed_symbols: SymbolInfo[];
  impacted_files: ImpactedFile[];
  impacted_symbols: ImpactedSymbol[];
  selected_tests: SelectedTest[];
  test_files_total: number;
  truncated: boolean;
  limitations: string[];
}

const TEST_PATTERNS = [/(^|\/)(tests?|__tests__|spec)\//, /(^|\/)test_[^/]+\.py$/, /(^|\/)[^/]+_test\.py$/, /\.(test|spec)\.[cm]?[jt]sx?$/];

export function isTestFile(path: string): boolean {
  if (/(^|\/)conftest\.py$/.test(path) || /(^|\/)__init__\.py$/.test(path)) return false;
  if (!/\.(py|[cm]?[jt]sx?)$/.test(path)) return false;
  return TEST_PATTERNS.some((re) => re.test(path));
}

/** File stem a test is conventionally named after: `test_foo.py` / `foo_test.py` / `foo.test.ts` → `foo`. */
export function testSubjectStem(path: string): string | null {
  const base = path.split('/').pop() ?? '';
  const m = /^test_(.+)\.py$/.exec(base) ?? /^(.+)_test\.py$/.exec(base) ?? /^(.+)\.(?:test|spec)\.[cm]?[jt]sx?$/.exec(base);
  return m ? m[1]! : null;
}

function stem(path: string): string {
  return (path.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
}

export const MAX_IMPORT_DEPTH = 4;
export const MAX_CALL_DEPTH = 2;
const MAX_CHANGED_SYMBOLS = 300;
const MAX_IMPACTED = 500;

const overlaps = (s: SymbolInfo, ranges: Array<[number, number]> | undefined) => !ranges || ranges.some(([a, b]) => s.start_line <= b && s.end_line >= a);

/** Score for a test reached through `distance` import hops (1 = imports a changed file directly). */
const importScore = (distance: number) => Math.max(0.3, 0.95 - 0.15 * (distance - 1));
const callScore = (depth: number) => Math.max(0.3, 0.85 - 0.15 * (depth - 1));
const NAMING_SCORE = 0.5;

export function predictImpact(graph: CodeGraph, changed: ChangedFile[], opts: { maxTests?: number } = {}): ImpactResult {
  const maxTests = opts.maxTests ?? 20;
  const changedPaths = new Set(changed.map((c) => c.path));
  const rangesByPath = new Map(changed.map((c) => [c.path, c.ranges]));

  // --- Reverse import graph BFS: who (transitively) imports a changed file.
  const importedBy = new Map<string, ImportEdge[]>();
  for (const e of graph.imports) {
    if (e.from === e.to) continue;
    const list = importedBy.get(e.to) ?? [];
    list.push(e);
    importedBy.set(e.to, list);
  }
  for (const list of importedBy.values()) list.sort((a, b) => a.from.localeCompare(b.from) || (a.line ?? 0) - (b.line ?? 0));

  const impacted = new Map<string, ImpactedFile>();
  let truncated = false;
  let frontier = [...changedPaths].sort().map((p) => ({ path: p, chain: [] as EvidenceStep[] }));
  for (let depth = 1; depth <= MAX_IMPORT_DEPTH && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      for (const e of importedBy.get(node.path) ?? []) {
        if (changedPaths.has(e.from) || impacted.has(e.from)) continue;
        if (impacted.size >= MAX_IMPACTED) {
          truncated = true;
          break;
        }
        const chain: EvidenceStep[] = [{ kind: 'imports', from: e.from, to: e.to, line: e.line }, ...node.chain];
        impacted.set(e.from, { path: e.from, distance: depth, reason: 'imports', evidence: chain });
        next.push({ path: e.from, chain });
      }
    }
    frontier = next;
  }

  // --- Changed symbols and reverse call graph BFS (name-resolved edges only).
  const symbolsByPath = new Map<string, SymbolInfo[]>();
  for (const s of graph.symbols.values()) {
    const list = symbolsByPath.get(s.path) ?? [];
    list.push(s);
    symbolsByPath.set(s.path, list);
  }
  const changedSymbols: SymbolInfo[] = [];
  for (const p of [...changedPaths].sort()) {
    for (const s of (symbolsByPath.get(p) ?? []).sort((a, b) => a.start_line - b.start_line || a.id.localeCompare(b.id))) {
      if (s.kind === 'module' || !overlaps(s, rangesByPath.get(p))) continue;
      if (changedSymbols.length >= MAX_CHANGED_SYMBOLS) {
        truncated = true;
        break;
      }
      changedSymbols.push(s);
    }
  }
  const callersOf = new Map<string, CallEdge[]>();
  for (const e of graph.calls) {
    const list = callersOf.get(e.target_symbol_id) ?? [];
    list.push(e);
    callersOf.set(e.target_symbol_id, list);
  }
  const reachedSymbols = new Map<string, ImpactedSymbol>();
  const changedIds = new Set(changedSymbols.map((s) => s.id));
  let symFrontier = changedSymbols.map((s) => ({ id: s.id, chain: [] as EvidenceStep[] }));
  for (let depth = 1; depth <= MAX_CALL_DEPTH && symFrontier.length > 0; depth++) {
    const next: typeof symFrontier = [];
    for (const node of symFrontier) {
      const callee = graph.symbols.get(node.id);
      if (!callee) continue;
      const edges = [...(callersOf.get(node.id) ?? [])].sort((a, b) => a.source_symbol_id.localeCompare(b.source_symbol_id) || (a.line ?? 0) - (b.line ?? 0));
      for (const e of edges) {
        const caller = graph.symbols.get(e.source_symbol_id);
        if (!caller || changedIds.has(caller.id) || reachedSymbols.has(caller.id)) continue;
        if (reachedSymbols.size >= MAX_IMPACTED) {
          truncated = true;
          break;
        }
        const chain: EvidenceStep[] = [{ kind: 'calls', from: caller.path, to: callee.path, line: e.line, caller: caller.qualified_name ?? caller.name, callee: callee.qualified_name ?? callee.name }, ...node.chain];
        reachedSymbols.set(caller.id, { symbol: caller, depth, evidence: chain });
        next.push({ id: caller.id, chain });
        if (!changedPaths.has(caller.path) && !impacted.has(caller.path) && impacted.size < MAX_IMPACTED) {
          impacted.set(caller.path, { path: caller.path, distance: depth, reason: 'calls', evidence: chain });
        }
      }
    }
    symFrontier = next;
  }

  // --- Test selection: score every test file by its strongest signal; keep up to three reasons.
  const testFiles = [...new Set([...graph.files, ...changedPaths])].filter(isTestFile).sort();
  const scored = new Map<string, SelectedTest>();
  const add = (path: string, score: number, reason: SelectedTest['reasons'][number]) => {
    const t = scored.get(path) ?? { path, score: 0, reasons: [] };
    t.score = Math.max(t.score, score);
    if (t.reasons.length < 3 && !t.reasons.some((r) => r.kind === reason.kind)) t.reasons.push(reason);
    scored.set(path, t);
  };
  const changedNonTestStems = new Map<string, string>();
  for (const p of changedPaths) if (!isTestFile(p)) changedNonTestStems.set(stem(p), p);
  for (const t of testFiles) {
    if (changedPaths.has(t)) add(t, 1, { kind: 'changed', description: 'The test file itself is changed.', evidence: [{ kind: 'changed', path: t }] });
    const imp = impacted.get(t);
    if (imp?.reason === 'imports') {
      const target = imp.evidence.at(-1);
      add(t, importScore(imp.distance), {
        kind: 'imports',
        description: imp.distance === 1 ? `Imports changed file ${target && 'to' in target ? target.to : ''}`.trim() : `Reaches a changed file through ${imp.distance} imports`,
        evidence: imp.evidence,
      });
    }
    const calling = [...reachedSymbols.values()].filter((r) => r.symbol.path === t).sort((a, b) => a.depth - b.depth)[0];
    if (calling) add(t, callScore(calling.depth), { kind: 'calls', description: calling.depth === 1 ? 'Calls a changed symbol' : `Calls a changed symbol through ${calling.depth} calls`, evidence: calling.evidence });
    const subject = testSubjectStem(t);
    const named = subject ? changedNonTestStems.get(subject) : undefined;
    if (named) add(t, NAMING_SCORE, { kind: 'naming', description: `Named after changed file ${named}`, evidence: [{ kind: 'naming', from: t, to: named }] });
  }
  const selected = [...scored.values()].map((t) => ({ ...t, score: Number(t.score.toFixed(2)) })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (selected.length > maxTests) truncated = true;

  return {
    heuristic: true,
    changed_files: [...changedPaths].sort().map((p) => ({ path: p, indexed: graph.files.has(p), symbols: (symbolsByPath.get(p) ?? []).filter((s) => s.kind !== 'module').length })),
    changed_symbols: changedSymbols,
    impacted_files: [...impacted.values()].sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path)),
    impacted_symbols: [...reachedSymbols.values()].sort((a, b) => a.depth - b.depth || a.symbol.path.localeCompare(b.symbol.path) || a.symbol.start_line - b.symbol.start_line),
    selected_tests: selected.slice(0, maxTests),
    test_files_total: testFiles.length,
    truncated,
    limitations: IMPACT_LIMITATIONS,
  };
}

export const IMPACT_DISCLAIMER =
  'Heuristic prediction from static imports and name-resolved calls. It can miss real impact and is not a verification result: only the deterministic checks decide pass or fail.';

export const IMPACT_LIMITATIONS = [
  'Calls are linked by name only when the name is unambiguous in the snapshot; dynamic dispatch, callbacks and reflection are not followed.',
  'Path aliases (tsconfig paths, package exports) and dynamic imports with computed specifiers are not resolved.',
  'Runtime configuration, fixtures and data files are not part of the graph.',
  `Import chains are followed ${MAX_IMPORT_DEPTH} levels deep and call chains ${MAX_CALL_DEPTH} levels deep.`,
];

/**
 * Changed old-side line ranges per file from a unified diff (only `@@ -a,b +c,d @@` headers are read).
 * Files created by the patch have no old-side ranges and are reported with ranges = [] (no snapshot symbols).
 */
export function changedRangesFromDiff(diff: string): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      current = p === '/dev/null' ? null : p.replace(/^a\//, '');
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (m && current) {
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      // A pure insertion (len 0) sits after `start`; treat it as touching that line.
      out.get(current)!.push([Math.max(1, start), Math.max(1, start + Math.max(len, 1) - 1)]);
    }
  }
  return out;
}

export interface CallGraphNode {
  symbol: SymbolInfo;
  depth: number;
  direction: 'caller' | 'callee';
}

export interface CallGraphEdge {
  source_id: string;
  target_id: string;
  type: string;
  line: number | null;
  /** File of the call site (the source symbol's file). */
  path: string;
}

/** Bounded BFS over call/instantiate edges from `rootId`, in one or both directions. */
export function callGraph(graph: Pick<CodeGraph, 'symbols' | 'calls'>, rootId: string, direction: 'callers' | 'callees' | 'both', depth: number, maxNodes: number) {
  const nodes = new Map<string, CallGraphNode>();
  const edges: CallGraphEdge[] = [];
  const seenEdge = new Set<string>();
  let truncated = false;
  const out = new Map<string, CallEdge[]>();
  const inc = new Map<string, CallEdge[]>();
  for (const e of graph.calls) {
    (out.get(e.source_symbol_id) ?? out.set(e.source_symbol_id, []).get(e.source_symbol_id)!).push(e);
    (inc.get(e.target_symbol_id) ?? inc.set(e.target_symbol_id, []).get(e.target_symbol_id)!).push(e);
  }
  const sortEdges = (list: CallEdge[]) => [...list].sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.source_symbol_id.localeCompare(b.source_symbol_id) || a.target_symbol_id.localeCompare(b.target_symbol_id));
  const walk = (dir: 'caller' | 'callee') => {
    let frontier = [rootId];
    const visited = new Set([rootId]);
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of sortEdges((dir === 'caller' ? inc.get(id) : out.get(id)) ?? [])) {
          const otherId = dir === 'caller' ? e.source_symbol_id : e.target_symbol_id;
          const other = graph.symbols.get(otherId);
          const source = graph.symbols.get(e.source_symbol_id);
          if (!other || !source) continue;
          const key = `${e.source_symbol_id}|${e.target_symbol_id}|${e.type}|${e.line}`;
          if (!visited.has(otherId)) {
            if (nodes.size >= maxNodes) {
              truncated = true;
              continue;
            }
            visited.add(otherId);
            if (!nodes.has(otherId)) nodes.set(otherId, { symbol: other, depth: d, direction: dir });
            next.push(otherId);
          }
          if (!seenEdge.has(key) && (nodes.has(otherId) || otherId === rootId)) {
            seenEdge.add(key);
            edges.push({ source_id: e.source_symbol_id, target_id: e.target_symbol_id, type: e.type, line: e.line, path: source.path });
          }
        }
      }
      frontier = next;
    }
  };
  if (direction !== 'callees') walk('caller');
  if (direction !== 'callers') walk('callee');
  const ordered = [...nodes.values()].sort((a, b) => a.depth - b.depth || (a.direction === b.direction ? 0 : a.direction === 'caller' ? -1 : 1) || a.symbol.path.localeCompare(b.symbol.path) || a.symbol.start_line - b.symbol.start_line || a.symbol.id.localeCompare(b.symbol.id));
  return { nodes: ordered, edges, truncated };
}
