/**
 * Resolves import specifiers recorded by the parser to files in the same
 * snapshot (GAP-15 dependency map). Purely path-based: repository content is
 * never executed, and no tsconfig/package.json path aliases are interpreted.
 */

export type ImportResolution = { kind: 'internal'; path: string } | { kind: 'external'; name: string } | { kind: 'unresolved' };

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx']);

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Joins and normalizes `a/b` + `../c` → `a/c`; returns null when it escapes the repository root. */
export function joinPath(base: string, rel: string): string | null {
  const out: string[] = base === '' ? [] : base.split('/');
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

function firstHit(files: ReadonlySet<string>, candidates: string[]): string | null {
  for (const c of candidates) if (c !== '' && files.has(c)) return c;
  return null;
}

function resolveJs(fromPath: string, spec: string, files: ReadonlySet<string>): ImportResolution {
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    if (spec.startsWith('node:')) return { kind: 'external', name: spec };
    const parts = spec.split('/');
    return { kind: 'external', name: spec.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]! };
  }
  const target = spec.startsWith('/') ? joinPath('', spec) : joinPath(dirname(fromPath), spec);
  if (target === null) return { kind: 'unresolved' };
  // TypeScript ESM imports name the emitted `.js` file; map it back to sources.
  const stem = target.replace(/\.(m|c)?jsx?$/, '');
  const candidates = [target, ...JS_EXTS.map((e) => `${stem}${e}`), ...JS_EXTS.map((e) => `${target}/index${e}`)];
  const hit = firstHit(files, candidates);
  return hit ? { kind: 'internal', path: hit } : { kind: 'unresolved' };
}

function pythonCandidates(modulePath: string): string[] {
  return modulePath === '' ? [] : [`${modulePath}.py`, `${modulePath}/__init__.py`];
}

function resolvePython(fromPath: string, spec: string, files: ReadonlySet<string>): ImportResolution {
  const dots = /^\.*/.exec(spec)![0].length;
  const rest = spec.slice(dots);
  if (dots > 0) {
    let base: string | null = dirname(fromPath);
    for (let i = 1; i < dots && base !== null; i++) base = base === '' ? null : dirname(base);
    if (base === null) return { kind: 'unresolved' };
    if (rest === '') {
      const hit = firstHit(files, [base === '' ? '__init__.py' : `${base}/__init__.py`]);
      return hit ? { kind: 'internal', path: hit } : { kind: 'unresolved' };
    }
    const mod = joinPath(base, rest.replace(/\./g, '/'));
    const hit = mod === null ? null : firstHit(files, pythonCandidates(mod));
    return hit ? { kind: 'internal', path: hit } : { kind: 'unresolved' };
  }
  // Absolute import: try the repository root, a `src/` layout and the importer's own directory,
  // then shorter prefixes (`a.b.c` may name an attribute of module `a.b`).
  const segments = rest.split('.');
  const roots = ['', 'src', dirname(fromPath)];
  for (let n = segments.length; n >= 1; n--) {
    const mod = segments.slice(0, n).join('/');
    for (const root of roots) {
      const full = root === '' ? mod : `${root}/${mod}`;
      const hit = firstHit(files, pythonCandidates(full));
      if (hit && hit !== fromPath) return { kind: 'internal', path: hit };
    }
  }
  return { kind: 'external', name: segments[0]! };
}

export function resolveImport(fromPath: string, language: string | null, spec: string, files: ReadonlySet<string>): ImportResolution {
  if (!spec) return { kind: 'unresolved' };
  if (language === 'python') return resolvePython(fromPath, spec, files);
  if (language && JS_LANGS.has(language)) return resolveJs(fromPath, spec, files);
  return { kind: 'unresolved' };
}
