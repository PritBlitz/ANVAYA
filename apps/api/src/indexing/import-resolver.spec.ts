import { describe, expect, it } from 'vitest';
import { joinPath, resolveImport } from './import-resolver.js';

const files = new Set([
  'src/auth/jwt.ts',
  'src/auth/token.ts',
  'src/ui/index.tsx',
  'src/util.js',
  'textstats/__init__.py',
  'textstats/core.py',
  'tests/test_core.py',
  'src/pkg/__init__.py',
  'src/pkg/mod.py',
  'pkg2/a/b.py',
]);

describe('joinPath', () => {
  it('normalizes and refuses to escape the root', () => {
    expect(joinPath('a/b', '../c')).toBe('a/c');
    expect(joinPath('a', './b/./c')).toBe('a/b/c');
    expect(joinPath('', '../x')).toBeNull();
  });
});

describe('resolveImport (JS/TS)', () => {
  it('resolves relative imports with extension and index probing', () => {
    expect(resolveImport('src/auth/jwt.ts', 'typescript', './token', files)).toEqual({ kind: 'internal', path: 'src/auth/token.ts' });
    expect(resolveImport('src/auth/jwt.ts', 'typescript', './token.js', files)).toEqual({ kind: 'internal', path: 'src/auth/token.ts' });
    expect(resolveImport('src/auth/jwt.ts', 'typescript', '../ui', files)).toEqual({ kind: 'internal', path: 'src/ui/index.tsx' });
    expect(resolveImport('src/auth/jwt.ts', 'typescript', '../util', files)).toEqual({ kind: 'internal', path: 'src/util.js' });
  });
  it('classifies packages as external, keeping npm scopes', () => {
    expect(resolveImport('src/auth/jwt.ts', 'typescript', 'jsonwebtoken', files)).toEqual({ kind: 'external', name: 'jsonwebtoken' });
    expect(resolveImport('src/auth/jwt.ts', 'typescript', '@nestjs/common/x', files)).toEqual({ kind: 'external', name: '@nestjs/common' });
    expect(resolveImport('src/auth/jwt.ts', 'javascript', 'node:fs', files)).toEqual({ kind: 'external', name: 'node:fs' });
  });
  it('reports missing or escaping relative targets as unresolved', () => {
    expect(resolveImport('src/auth/jwt.ts', 'typescript', './missing', files)).toEqual({ kind: 'unresolved' });
    expect(resolveImport('src/auth/jwt.ts', 'typescript', '../../../../x', files)).toEqual({ kind: 'unresolved' });
  });
});

describe('resolveImport (Python)', () => {
  it('resolves relative imports', () => {
    expect(resolveImport('textstats/__init__.py', 'python', '.core', files)).toEqual({ kind: 'internal', path: 'textstats/core.py' });
    expect(resolveImport('textstats/core.py', 'python', '.', files)).toEqual({ kind: 'internal', path: 'textstats/__init__.py' });
    expect(resolveImport('src/pkg/mod.py', 'python', '..pkg.mod', files)).toEqual({ kind: 'internal', path: 'src/pkg/mod.py' });
  });
  it('resolves absolute imports from the root, src/ layouts and attribute prefixes', () => {
    expect(resolveImport('tests/test_core.py', 'python', 'textstats', files)).toEqual({ kind: 'internal', path: 'textstats/__init__.py' });
    expect(resolveImport('tests/test_core.py', 'python', 'pkg.mod', files)).toEqual({ kind: 'internal', path: 'src/pkg/mod.py' });
    expect(resolveImport('tests/test_core.py', 'python', 'pkg2.a.b.func', files)).toEqual({ kind: 'internal', path: 'pkg2/a/b.py' });
  });
  it('classifies the stdlib and packages as external', () => {
    expect(resolveImport('textstats/core.py', 'python', 'collections', files)).toEqual({ kind: 'external', name: 'collections' });
    expect(resolveImport('textstats/core.py', 'python', 'os.path', files)).toEqual({ kind: 'external', name: 'os' });
  });
  it('ignores unsupported languages', () => {
    expect(resolveImport('a.go', 'go', 'fmt', files)).toEqual({ kind: 'unresolved' });
  });
});
