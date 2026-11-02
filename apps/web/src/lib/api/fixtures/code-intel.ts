/**
 * DEVELOPMENT FIXTURE — a tiny, regex-based stand-in for the backend's symbol parser
 * and import resolver (GAP-15), so the symbol explorer and dependency map work in
 * fixture mode. Wire shapes match the backend contract (feat/backend 3a53222).
 */
import type * as W from "../wire";
import type { FixtureFile } from "./repo-content";

interface ParsedSymbol extends W.WSymbol {
  /** Lines the symbol spans, used to attribute references to the enclosing symbol. */
  body: [number, number];
}

const TS_DECL: { re: RegExp; kind: string }[] = [
  {
    re: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\)[^{]*)/,
    kind: "function",
  },
  { re: /^export\s+class\s+([A-Za-z_$][\w$]*)([^{]*)/, kind: "class" },
  { re: /^export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/, kind: "module" },
  { re: /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\)[^{]*)/, kind: "function" },
  { re: /^type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type" },
];
const TS_METHOD = /^\s{2}(?:async\s+)?([a-z_$][\w$]*)\s*(\([^)]*\)[^{;]*)\{\s*$/;
const PY_DECL = /^(\s*)(def|class)\s+([A-Za-z_]\w*)\s*(\([^)]*\))?[^:]*:/;

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
};
const symbolId = (path: string, name: string, line: number) =>
  `sym-${hash(`${path}#${name}#${line}`)}`;

function lines(file: FixtureFile): string[] {
  return file.content.replace(/\n$/, "").split("\n");
}

/** End of a brace-delimited block starting at `start` (0-based), or `start` if none. */
function blockEnd(src: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < src.length; i++) {
    for (const ch of src[i]!) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return i;
    if (!opened && i > start && /;\s*$/.test(src[i - 1] ?? "")) return i - 1;
  }
  return opened ? src.length - 1 : start;
}

function pyBlockEnd(src: string[], start: number, indent: number): number {
  let end = start;
  for (let i = start + 1; i < src.length; i++) {
    const l = src[i]!;
    if (!l.trim()) continue;
    if (l.length - l.trimStart().length <= indent) break;
    end = i;
  }
  return end;
}

const parseCache = new Map<string, ParsedSymbol[]>();

export function parseSymbols(files: FixtureFile[], sha: string): ParsedSymbol[] {
  const key = `${sha}:${files.map((f) => f.path).join(",")}`;
  const cached = parseCache.get(key);
  if (cached) return cached;
  const out: ParsedSymbol[] = [];
  const snapshot_id = `snap-${sha.slice(0, 8)}`;
  const push = (
    f: FixtureFile,
    name: string,
    qualified: string,
    kind: string,
    start: number,
    end: number,
    signature: string | null,
  ) =>
    out.push({
      id: symbolId(f.path, qualified, start + 1),
      name,
      qualified_name: qualified,
      kind,
      path: f.path,
      start_line: start + 1,
      end_line: end + 1,
      language: f.language,
      signature,
      snapshot_id,
      commit_sha: sha,
      body: [start + 1, end + 1],
    });

  for (const f of files) {
    if (f.excluded) continue;
    const src = lines(f);
    if (f.language === "typescript" || f.language === "javascript") {
      let currentClass: { name: string; end: number } | null = null;
      src.forEach((line, i) => {
        if (currentClass && i > currentClass.end) currentClass = null;
        if (currentClass) {
          const m = line.match(TS_METHOD);
          if (m && !["if", "for", "while", "switch", "catch", "constructor"].includes(m[1]!)) {
            const end = blockEnd(src, i);
            push(
              f,
              m[1]!,
              `${currentClass.name}.${m[1]}`,
              "method",
              i,
              end,
              `${m[1]}${m[2]!.trim()}`,
            );
          }
          return;
        }
        for (const d of TS_DECL) {
          const m = line.match(d.re);
          if (!m) continue;
          const end = d.kind === "type" && !line.includes("{") ? i : blockEnd(src, i);
          const sig =
            d.kind === "function"
              ? `${m[1]}${(m[2] ?? "").trim()}`
              : line.replace(/\s*[={]\s*$/, "").trim();
          push(f, m[1]!, m[1]!, d.kind, i, end, sig);
          if (d.kind === "class") currentClass = { name: m[1]!, end };
          break;
        }
      });
    } else if (f.language === "python") {
      const stack: { name: string; indent: number; end: number }[] = [];
      src.forEach((line, i) => {
        const m = line.match(PY_DECL);
        if (!m) return;
        const indent = m[1]!.length;
        while (stack.length && (stack.at(-1)!.indent >= indent || i > stack.at(-1)!.end))
          stack.pop();
        const parent = stack.at(-1);
        const kind = m[2] === "class" ? "class" : parent ? "method" : "function";
        const end = pyBlockEnd(src, i, indent);
        const qualified = parent ? `${parent.name}.${m[3]}` : m[3]!;
        push(f, m[3]!, qualified, kind, i, end, `${m[2]} ${m[3]}${m[4] ?? ""}`);
        if (m[2] === "class") stack.push({ name: m[3]!, indent, end });
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  parseCache.set(key, out);
  return out;
}

export function toWire(s: ParsedSymbol): W.WSymbol {
  return {
    id: s.id,
    name: s.name,
    qualified_name: s.qualified_name,
    kind: s.kind,
    path: s.path,
    start_line: s.start_line,
    end_line: s.end_line,
    language: s.language,
    signature: s.signature,
    snapshot_id: s.snapshot_id,
    commit_sha: s.commit_sha,
  };
}

// ── imports ───────────────────────────────────────────────────────────────

interface ImportRef {
  from: string;
  line: number;
  names: string[];
  /** Resolved repository path, or null when external/unresolved. */
  target: string | null;
  external: string | null;
}

function resolveTs(from: string, spec: string, paths: Set<string>): string | null {
  const dir = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") dir.pop();
    else if (part !== ".") dir.push(part);
  }
  const base = dir.join("/").replace(/\.js$/, "");
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`]) {
    if (paths.has(cand)) return cand;
  }
  return null;
}

function resolvePy(from: string, spec: string, paths: Set<string>): string | null {
  if (spec.startsWith(".")) {
    const dots = spec.match(/^\.+/)![0].length;
    const dir = from.split("/").slice(0, -dots);
    const cand = [...dir, ...spec.slice(dots).split(".")].join("/") + ".py";
    return paths.has(cand) ? cand : null;
  }
  const cand = spec.split(".").join("/") + ".py";
  return paths.has(cand) ? cand : null;
}

export function parseImports(files: FixtureFile[]): ImportRef[] {
  const paths = new Set(files.filter((f) => !f.excluded).map((f) => f.path));
  const out: ImportRef[] = [];
  for (const f of files) {
    if (f.excluded) continue;
    lines(f).forEach((line, i) => {
      if (f.language === "typescript" || f.language === "javascript") {
        const m = line.match(
          /^import\s+(?:type\s+)?(?:\{([^}]*)\}|([\w$]+))?\s*(?:from\s+)?["']([^"']+)["']/,
        );
        if (!m) return;
        const names = (m[1] ?? m[2] ?? "")
          .split(",")
          .map((n) => n.trim().split(/\s+as\s+/)[0]!)
          .filter(Boolean);
        const spec = m[3]!;
        const target = spec.startsWith(".") ? resolveTs(f.path, spec, paths) : null;
        out.push({
          from: f.path,
          line: i + 1,
          names,
          target,
          external: spec.startsWith(".") ? null : spec.replace(/^node:/, "").split("/")[0]!,
        });
      } else if (f.language === "python") {
        const m =
          line.match(/^from\s+([.\w]+)\s+import\s+(.+)$/) ?? line.match(/^import\s+([.\w]+)()/);
        if (!m) return;
        const spec = m[1]!;
        const names = (m[2] ?? "")
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        const target = resolvePy(f.path, spec, paths);
        out.push({
          from: f.path,
          line: i + 1,
          names,
          target,
          external: target || spec.startsWith(".") ? null : spec.split(".")[0]!,
        });
      }
    });
  }
  return out;
}

// ── references ────────────────────────────────────────────────────────────

interface Reference {
  type: "calls" | "extends" | "instantiates" | "imports";
  line: number;
  source: ParsedSymbol | null;
  sourcePath: string;
  target: ParsedSymbol | null;
  target_name: string;
}

function enclosing(symbols: ParsedSymbol[], path: string, line: number): ParsedSymbol | null {
  let best: ParsedSymbol | null = null;
  for (const s of symbols) {
    if (s.path !== path || line < s.body[0] || line > s.body[1]) continue;
    if (!best || s.body[1] - s.body[0] < best.body[1] - best.body[0]) best = s;
  }
  return best;
}

export function references(files: FixtureFile[], sha: string): Reference[] {
  const symbols = parseSymbols(files, sha);
  const imports = parseImports(files);
  const byName = new Map<string, ParsedSymbol[]>();
  for (const s of symbols) {
    if (s.kind === "method") continue;
    byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  }
  const refs: Reference[] = [];
  // Names visible in each file: its own top-level symbols plus resolved imports.
  for (const f of files) {
    if (f.excluded) continue;
    const visible = new Map<string, ParsedSymbol | null>();
    for (const s of symbols) if (s.path === f.path && s.kind !== "method") visible.set(s.name, s);
    for (const imp of imports.filter((i) => i.from === f.path)) {
      for (const n of imp.names) {
        const target = imp.target
          ? ((byName.get(n) ?? []).find((s) => s.path === imp.target) ?? null)
          : null;
        visible.set(n, target);
        refs.push({
          type: "imports",
          line: imp.line,
          source: null,
          sourcePath: f.path,
          target,
          target_name: n,
        });
      }
    }
    lines(f).forEach((line, i) => {
      const ln = i + 1;
      if (/^\s*(import|from)\s/.test(line)) return;
      const ext =
        line.match(/\b(?:extends|implements)\s+([A-Za-z_$][\w$]*)/) ??
        line.match(/^class\s+\w+\((\w+)\)/);
      if (ext && visible.has(ext[1]!)) {
        refs.push({
          type: "extends",
          line: ln,
          source: enclosing(symbols, f.path, ln),
          sourcePath: f.path,
          target: visible.get(ext[1]!) ?? null,
          target_name: ext[1]!,
        });
      }
      for (const m of line.matchAll(/\b(new\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = m[2]!;
        if (!visible.has(name)) continue;
        const target = visible.get(name) ?? null;
        // A declaration line is not a call of itself.
        if (target && target.path === f.path && target.start_line === ln) continue;
        const kind = m[1] || target?.kind === "class" ? "instantiates" : "calls";
        refs.push({
          type: kind,
          line: ln,
          source: enclosing(symbols, f.path, ln),
          sourcePath: f.path,
          target,
          target_name: name,
        });
      }
    });
  }
  return refs;
}

export function symbolDetail(
  files: FixtureFile[],
  sha: string,
  id: string,
): W.WSymbolDetail | null {
  const symbols = parseSymbols(files, sha);
  const symbol = symbols.find((s) => s.id === id);
  if (!symbol) return null;
  const refs = references(files, sha);
  const outgoing = refs
    .filter((r) => r.source?.id === symbol.id)
    .map((r) => ({
      type: r.type,
      line: r.line,
      target: r.target ? toWire(r.target) : null,
      target_name: r.target_name,
    }));
  const incoming = refs
    .filter((r) => r.target?.id === symbol.id && r.source && r.source.id !== symbol.id)
    .map((r) => ({ type: r.type, line: r.line, source: toWire(r.source!) }));
  return {
    snapshot_id: symbol.snapshot_id,
    commit_sha: sha,
    symbol: toWire(symbol),
    outgoing: outgoing.slice(0, 200),
    incoming: incoming.slice(0, 200),
    truncated: outgoing.length > 200 || incoming.length > 200,
  };
}

export function dependencyMap(files: FixtureFile[], sha: string, scope: string): W.WDependencyMap {
  const prefix = scope ? `${scope.replace(/\/+$/, "")}/` : "";
  const included = files.filter(
    (f) => !f.excluded && f.language && ["typescript", "javascript", "python"].includes(f.language),
  );
  const imports = parseImports(included);
  const symbols = parseSymbols(included, sha);
  const inScope = (p: string) => !prefix || p.startsWith(prefix);
  const edgeMap = new Map<string, W.WDependencyMap["edges"][number]>();
  const external = new Map<string, { count: number; importers: Set<string> }>();
  let unresolved = 0;
  for (const imp of imports) {
    if (!inScope(imp.from)) continue;
    if (imp.target) {
      const k = `${imp.from}→${imp.target}`;
      const e = edgeMap.get(k) ?? { source: imp.from, target: imp.target, count: 0, lines: [] };
      e.count++;
      e.lines.push(imp.line);
      edgeMap.set(k, e);
    } else if (imp.external) {
      const x = external.get(imp.external) ?? { count: 0, importers: new Set() };
      x.count++;
      x.importers.add(imp.from);
      external.set(imp.external, x);
    } else unresolved++;
  }
  const edges = [...edgeMap.values()];
  const nodePaths = new Set<string>([
    ...included.filter((f) => inScope(f.path)).map((f) => f.path),
    ...edges.map((e) => e.target),
  ]);
  const nodes = [...nodePaths].sort().map((p) => {
    const f = included.find((x) => x.path === p)!;
    return {
      path: p,
      language: f.language,
      line_count: lines(f).length,
      symbol_count: symbols.filter((s) => s.path === p).length,
      imports: edges.filter((e) => e.source === p).length,
      imported_by: edges.filter((e) => e.target === p).length,
      in_scope: inScope(p),
    };
  });
  return {
    snapshot_id: `snap-${sha.slice(0, 8)}`,
    commit_sha: sha,
    path: scope || null,
    nodes,
    edges,
    external: [...external.entries()]
      .map(([name, x]) => ({ name, count: x.count, importer_count: x.importers.size }))
      .sort((a, b) => b.importer_count - a.importer_count || a.name.localeCompare(b.name)),
    unresolved_imports: unresolved,
    truncated: false,
    limitations: ["tsconfig path aliases are not resolved."],
  };
}
