/**
 * Fixture parity for work package B. Built-in templates mirror apps/api/src/templates/templates.ts;
 * the impact and call-graph algorithms are a port of apps/api/src/intelligence/graph.ts, run over
 * the fixture repository's parsed symbols, imports and references.
 */
import type * as T from "../types";
import { parseImports, parseSymbols, references } from "./code-intel";
import type { FixtureFile } from "./repo-content";

type Def = Omit<
  T.WorkflowTemplate,
  "id" | "source" | "plan_only" | "version" | "status" | "created_at" | "updated_at"
>;

export const BUILTIN_TEMPLATES: Def[] = [
  {
    key: "bug_fix",
    name: "Bug fix",
    description: "Find the root cause of a defect and fix it with a regression test.",
    workflow: "change",
    task_defaults: {
      title_prefix: "Fix: ",
      description_template:
        "## Observed behaviour\n\n## Expected behaviour\n\n## Steps to reproduce\n",
      labels: ["bug"],
    },
    budget: { max_changed_files: 5, max_repair_attempts: 2 },
    allowed_profiles: null,
    planning_guidance: [
      "Identify the root cause before proposing a change, and cite the evidence that shows it.",
      "Keep the change minimal and limited to the defect; no unrelated refactoring.",
      "Include a regression test that fails before the fix and passes after it, where the repository has a test framework.",
    ],
  },
  {
    key: "add_tests",
    name: "Add tests",
    description: "Add or extend tests for existing behaviour without changing it.",
    workflow: "change",
    task_defaults: {
      title_prefix: "Add tests: ",
      description_template: "## Behaviour to cover\n\n## Known edge cases\n",
      labels: ["tests"],
    },
    budget: { max_changed_files: 6, max_repair_attempts: 2 },
    allowed_profiles: null,
    planning_guidance: [
      "Add or extend tests only. Do not change production code; if a test cannot be written without a change, list that as a risk instead.",
      "Follow the repository's existing test framework, file layout and naming conventions.",
      "Cover the behaviour named in the task, including edge cases and failure paths.",
    ],
  },
  {
    key: "refactor",
    name: "Refactor",
    description: "Restructure code while preserving its observable behaviour.",
    workflow: "change",
    task_defaults: {
      title_prefix: "Refactor: ",
      description_template:
        "## Current structure\n\n## Target structure\n\n## Behaviour that must not change\n",
      labels: ["refactor"],
    },
    budget: { max_changed_files: 8, max_repair_attempts: 1 },
    allowed_profiles: null,
    planning_guidance: [
      "Preserve externally observable behaviour; list any behaviour change as a risk.",
      "Name the existing tests that cover the code being restructured; they are the safety net.",
      "Order the steps so that each one leaves the code in a working state.",
    ],
  },
  {
    key: "dependency_upgrade",
    name: "Dependency upgrade",
    description: "Upgrade a dependency and adapt the code that uses its changed APIs.",
    workflow: "change",
    task_defaults: {
      title_prefix: "Upgrade ",
      description_template: "## Dependency and target version\n\n## Reason for the upgrade\n",
      labels: ["dependencies"],
    },
    budget: { max_changed_files: 6, max_repair_attempts: 2 },
    allowed_profiles: null,
    planning_guidance: [
      "Identify every manifest and lockfile that pins the dependency, and the code that uses its changed APIs.",
      "List possible breaking changes as risks; do not state changelog details that are not in the evidence.",
      "Plan verification that exercises the code paths that use the dependency.",
    ],
  },
  {
    key: "migration_plan",
    name: "Migration plan",
    description:
      "Plan-only: an evidence-backed migration plan with ordered steps, risks and rollback. Nothing is executed.",
    workflow: "migration_plan",
    task_defaults: {
      title_prefix: "Migration plan: ",
      description_template:
        "## What is being migrated\n\n## From → to\n\n## Constraints (downtime, data, compatibility)\n",
      labels: ["migration"],
    },
    budget: { max_repair_attempts: 0 },
    allowed_profiles: [],
    planning_guidance: [
      "This workflow produces a plan only; no code is changed or executed.",
      "Order the steps so the system stays deployable after each one, and give every step a rollback.",
      "List the affected areas with the evidence that shows them, and state what the evidence does not cover.",
    ],
  },
];

export const BUILTIN_KEYS = new Set(BUILTIN_TEMPLATES.map((t) => t.key));

export function builtinView(d: Def): T.WorkflowTemplate {
  return {
    ...structuredClone(d),
    id: null,
    source: "builtin",
    plan_only: d.workflow === "migration_plan",
    version: 1,
    status: "active",
    created_at: null,
    updated_at: null,
  };
}

export function snapshotOf(t: T.WorkflowTemplate): T.TemplateSnapshot {
  return {
    key: t.key,
    name: t.name,
    description: t.description,
    workflow: t.workflow,
    task_defaults: structuredClone(t.task_defaults),
    budget: { ...t.budget },
    allowed_profiles: t.allowed_profiles ? [...t.allowed_profiles] : null,
    planning_guidance: [...t.planning_guidance],
    source: t.source,
    template_id: t.id,
    version: t.version,
  };
}

// ── code graph (port of apps/api/src/intelligence/graph.ts) ──────────────────────

interface CallEdge {
  source_symbol_id: string;
  target_symbol_id: string;
  type: string;
  line: number | null;
}
interface ImportEdge {
  from: string;
  to: string;
  line: number | null;
}
interface CodeGraph {
  files: Set<string>;
  imports: ImportEdge[];
  symbols: Map<string, T.SymbolRef>;
  calls: CallEdge[];
}

export function buildGraph(files: FixtureFile[], sha: string): CodeGraph {
  const parsed = parseSymbols(files, sha);
  const symbols = new Map<string, T.SymbolRef>(
    parsed.map((s) => [
      s.id,
      {
        id: s.id,
        name: s.name,
        qualified_name: s.qualified_name,
        kind: s.kind,
        path: s.path,
        start_line: s.start_line,
        end_line: s.end_line,
      },
    ]),
  );
  const imports = parseImports(files)
    .filter((i) => i.target && i.target !== i.from)
    .map((i) => ({ from: i.from, to: i.target!, line: i.line }));
  const calls: CallEdge[] = references(files, sha)
    .filter((r) => (r.type === "calls" || r.type === "instantiates") && r.source && r.target)
    .map((r) => ({
      source_symbol_id: r.source!.id,
      target_symbol_id: r.target!.id,
      type: r.type,
      line: r.line,
    }));
  return {
    files: new Set(files.filter((f) => !f.excluded).map((f) => f.path)),
    imports,
    symbols,
    calls,
  };
}

const TEST_PATTERNS = [
  /(^|\/)(tests?|__tests__|spec)\//,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)[^/]+_test\.py$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
];

export function isTestFile(path: string): boolean {
  if (/(^|\/)conftest\.py$/.test(path) || /(^|\/)__init__\.py$/.test(path)) return false;
  if (!/\.(py|[cm]?[jt]sx?)$/.test(path)) return false;
  return TEST_PATTERNS.some((re) => re.test(path));
}

function testSubjectStem(path: string): string | null {
  const base = path.split("/").pop() ?? "";
  const m =
    /^test_(.+)\.py$/.exec(base) ??
    /^(.+)_test\.py$/.exec(base) ??
    /^(.+)\.(?:test|spec)\.[cm]?[jt]sx?$/.exec(base);
  return m ? m[1]! : null;
}
const stem = (p: string) => (p.split("/").pop() ?? "").replace(/\.[^.]+$/, "");

export const IMPACT_DISCLAIMER =
  "Heuristic prediction from static imports and name-resolved calls. It can miss real impact and is not a verification result: only the deterministic checks decide pass or fail.";
const MAX_IMPORT_DEPTH = 4;
const MAX_CALL_DEPTH = 2;
export const IMPACT_LIMITATIONS = [
  "Calls are linked by name only when the name is unambiguous in the snapshot; dynamic dispatch, callbacks and reflection are not followed.",
  "Path aliases (tsconfig paths, package exports) and dynamic imports with computed specifiers are not resolved.",
  "Runtime configuration, fixtures and data files are not part of the graph.",
  `Import chains are followed ${MAX_IMPORT_DEPTH} levels deep and call chains ${MAX_CALL_DEPTH} levels deep.`,
];

export function predictImpact(
  graph: CodeGraph,
  changed: { path: string; ranges?: [number, number][] }[],
  maxTests = 20,
): Omit<T.ImpactCore, "disclaimer"> {
  const changedPaths = new Set(changed.map((c) => c.path));
  const ranges = new Map(changed.map((c) => [c.path, c.ranges]));
  const importedBy = new Map<string, ImportEdge[]>();
  for (const e of graph.imports) importedBy.set(e.to, [...(importedBy.get(e.to) ?? []), e]);
  for (const list of importedBy.values())
    list.sort((a, b) => a.from.localeCompare(b.from) || (a.line ?? 0) - (b.line ?? 0));
  const impacted = new Map<string, T.ImpactCore["impacted_files"][number]>();
  let frontier = [...changedPaths]
    .sort()
    .map((p) => ({ path: p, chain: [] as T.ImpactEvidenceStep[] }));
  for (let depth = 1; depth <= MAX_IMPORT_DEPTH && frontier.length; depth++) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      for (const e of importedBy.get(node.path) ?? []) {
        if (changedPaths.has(e.from) || impacted.has(e.from)) continue;
        const chain: T.ImpactEvidenceStep[] = [
          { kind: "imports", from: e.from, to: e.to, line: e.line },
          ...node.chain,
        ];
        impacted.set(e.from, { path: e.from, distance: depth, reason: "imports", evidence: chain });
        next.push({ path: e.from, chain });
      }
    }
    frontier = next;
  }
  const byPath = new Map<string, T.SymbolRef[]>();
  for (const s of graph.symbols.values()) byPath.set(s.path, [...(byPath.get(s.path) ?? []), s]);
  const changedSymbols: T.SymbolRef[] = [];
  for (const p of [...changedPaths].sort()) {
    for (const s of (byPath.get(p) ?? []).sort((a, b) => a.start_line - b.start_line)) {
      const r = ranges.get(p);
      if (s.kind === "module" || (r && !r.some(([a, b]) => s.start_line <= b && s.end_line >= a)))
        continue;
      changedSymbols.push(s);
    }
  }
  const callersOf = new Map<string, CallEdge[]>();
  for (const e of graph.calls)
    callersOf.set(e.target_symbol_id, [...(callersOf.get(e.target_symbol_id) ?? []), e]);
  const reached = new Map<string, T.ImpactCore["impacted_symbols"][number]>();
  const changedIds = new Set(changedSymbols.map((s) => s.id));
  let symFrontier = changedSymbols.map((s) => ({ id: s.id, chain: [] as T.ImpactEvidenceStep[] }));
  for (let depth = 1; depth <= MAX_CALL_DEPTH && symFrontier.length; depth++) {
    const next: typeof symFrontier = [];
    for (const node of symFrontier) {
      const callee = graph.symbols.get(node.id);
      if (!callee) continue;
      for (const e of callersOf.get(node.id) ?? []) {
        const caller = graph.symbols.get(e.source_symbol_id);
        if (!caller || changedIds.has(caller.id) || reached.has(caller.id)) continue;
        const chain: T.ImpactEvidenceStep[] = [
          {
            kind: "calls",
            from: caller.path,
            to: callee.path,
            line: e.line,
            caller: caller.qualified_name ?? caller.name,
            callee: callee.qualified_name ?? callee.name,
          },
          ...node.chain,
        ];
        reached.set(caller.id, { symbol: caller, depth, evidence: chain });
        next.push({ id: caller.id, chain });
        if (!changedPaths.has(caller.path) && !impacted.has(caller.path))
          impacted.set(caller.path, {
            path: caller.path,
            distance: depth,
            reason: "calls",
            evidence: chain,
          });
      }
    }
    symFrontier = next;
  }
  const tests = [...new Set([...graph.files, ...changedPaths])].filter(isTestFile).sort();
  const scored = new Map<string, T.SelectedTest>();
  const add = (path: string, score: number, reason: T.SelectedTest["reasons"][number]) => {
    const t = scored.get(path) ?? { path, score: 0, reasons: [] };
    t.score = Math.max(t.score, score);
    if (t.reasons.length < 3 && !t.reasons.some((r) => r.kind === reason.kind))
      t.reasons.push(reason);
    scored.set(path, t);
  };
  const stems = new Map<string, string>();
  for (const p of changedPaths) if (!isTestFile(p)) stems.set(stem(p), p);
  for (const t of tests) {
    if (changedPaths.has(t))
      add(t, 1, {
        kind: "changed",
        description: "The test file itself is changed.",
        evidence: [{ kind: "changed", path: t }],
      });
    const imp = impacted.get(t);
    if (imp?.reason === "imports") {
      const last = imp.evidence.at(-1);
      add(t, Math.max(0.3, 0.95 - 0.15 * (imp.distance - 1)), {
        kind: "imports",
        description:
          imp.distance === 1
            ? `Imports changed file ${last && "to" in last ? last.to : ""}`.trim()
            : `Reaches a changed file through ${imp.distance} imports`,
        evidence: imp.evidence,
      });
    }
    const calling = [...reached.values()]
      .filter((r) => r.symbol.path === t)
      .sort((a, b) => a.depth - b.depth)[0];
    if (calling)
      add(t, Math.max(0.3, 0.85 - 0.15 * (calling.depth - 1)), {
        kind: "calls",
        description:
          calling.depth === 1
            ? "Calls a changed symbol"
            : `Calls a changed symbol through ${calling.depth} calls`,
        evidence: calling.evidence,
      });
    const subject = testSubjectStem(t);
    const named = subject ? stems.get(subject) : undefined;
    if (named)
      add(t, 0.5, {
        kind: "naming",
        description: `Named after changed file ${named}`,
        evidence: [{ kind: "naming", from: t, to: named }],
      });
  }
  const selected = [...scored.values()]
    .map((t) => ({ ...t, score: Number(t.score.toFixed(2)) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    heuristic: true,
    changed_files: [...changedPaths].sort().map((p) => ({
      path: p,
      indexed: graph.files.has(p),
      symbols: (byPath.get(p) ?? []).filter((s) => s.kind !== "module").length,
    })),
    changed_symbols: changedSymbols,
    impacted_files: [...impacted.values()].sort(
      (a, b) => a.distance - b.distance || a.path.localeCompare(b.path),
    ),
    impacted_symbols: [...reached.values()].sort(
      (a, b) => a.depth - b.depth || a.symbol.path.localeCompare(b.symbol.path),
    ),
    selected_tests: selected.slice(0, maxTests),
    test_files_total: tests.length,
    truncated: selected.length > maxTests,
    limitations: IMPACT_LIMITATIONS,
  };
}

export function callGraph(
  graph: CodeGraph,
  rootId: string,
  direction: T.CallGraphDirection,
  depth: number,
  maxNodes = 500,
) {
  const nodes = new Map<string, T.CallGraph["nodes"][number]>();
  const edges: T.CallGraph["edges"] = [];
  const seen = new Set<string>();
  let truncated = false;
  const sorted = (l: CallEdge[]) => [...l].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  const walk = (dir: "caller" | "callee") => {
    let frontier = [rootId];
    const visited = new Set([rootId]);
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const list = graph.calls.filter(
          (e) => (dir === "caller" ? e.target_symbol_id : e.source_symbol_id) === id,
        );
        for (const e of sorted(list)) {
          const otherId = dir === "caller" ? e.source_symbol_id : e.target_symbol_id;
          const other = graph.symbols.get(otherId);
          const source = graph.symbols.get(e.source_symbol_id);
          if (!other || !source) continue;
          if (!visited.has(otherId)) {
            if (nodes.size >= maxNodes) {
              truncated = true;
              continue;
            }
            visited.add(otherId);
            if (!nodes.has(otherId))
              nodes.set(otherId, { symbol: other, depth: d, direction: dir });
            next.push(otherId);
          }
          const key = `${e.source_symbol_id}|${e.target_symbol_id}|${e.type}|${e.line}`;
          if (!seen.has(key) && (nodes.has(otherId) || otherId === rootId)) {
            seen.add(key);
            edges.push({
              source_id: e.source_symbol_id,
              target_id: e.target_symbol_id,
              type: e.type,
              line: e.line,
              path: source.path,
            });
          }
        }
      }
      frontier = next;
    }
  };
  if (direction !== "callees") walk("caller");
  if (direction !== "callers") walk("callee");
  const ordered = [...nodes.values()].sort(
    (a, b) =>
      a.depth - b.depth ||
      (a.direction === b.direction ? 0 : a.direction === "caller" ? -1 : 1) ||
      a.symbol.path.localeCompare(b.symbol.path) ||
      a.symbol.start_line - b.symbol.start_line,
  );
  return { nodes: ordered, edges, truncated };
}
