import { describe, expect, it } from 'vitest';
import { PatchRejected, validatePatch } from './patch-validator.js';

const files: Record<string, string> = { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' };
const current = (p: string) => files[p] ?? null;
const opts = { allowedFiles: ['src/a.ts', 'src/new.ts'], maxChangedFiles: 2, current };

function rejects(changes: Array<{ path: string; action: 'modify' | 'create' | 'delete'; content?: string | null }>, code: string, o = opts) {
  try {
    validatePatch({ summary: 's', plan_revision_needed: false, changes: changes.map((c) => ({ explanation: 'x', ...c })) }, o);
  } catch (err) {
    expect(err).toBeInstanceOf(PatchRejected);
    expect((err as PatchRejected).code).toBe(code);
    return err as PatchRejected;
  }
  throw new Error('expected rejection');
}

describe('patch validator', () => {
  it('accepts an in-scope change and produces a unified diff and stable hash', () => {
    const p = { summary: 's', plan_revision_needed: false, changes: [{ path: 'src/a.ts', action: 'modify' as const, content: 'export const a = 42;\n', explanation: 'x' }] };
    const v = validatePatch(p, opts);
    expect(v.changes).toHaveLength(1);
    expect(v.additions).toBe(1);
    expect(v.deletions).toBe(1);
    expect(v.diff).toContain('--- a/src/a.ts');
    expect(v.diff).toContain('+export const a = 42;');
    expect(v.hash).toBe(validatePatch(p, opts).hash);
  });

  it('rejects files outside the approved plan', () => {
    const e = rejects([{ path: 'src/b.ts', action: 'modify', content: 'x' }], 'PATCH_OUT_OF_SCOPE');
    expect(e.details.join()).toContain('not in the approved plan: src/b.ts');
  });

  it('rejects traversal, absolute and backslash paths', () => {
    rejects([{ path: '../../etc/passwd', action: 'modify', content: 'x' }], 'PATCH_INVALID');
    rejects([{ path: '/etc/passwd', action: 'modify', content: 'x' }], 'PATCH_INVALID');
    rejects([{ path: 'src\\a.ts', action: 'modify', content: 'x' }], 'PATCH_INVALID');
  });

  it('rejects CI, VCS and credential paths even if the plan lists them', () => {
    const o = { ...opts, allowedFiles: ['.github/workflows/ci.yml', '.env', '.git/config'] };
    rejects([{ path: '.github/workflows/ci.yml', action: 'create', content: 'on: push' }], 'PATCH_OUT_OF_SCOPE', o);
    rejects([{ path: '.env', action: 'create', content: 'A=1' }], 'PATCH_OUT_OF_SCOPE', o);
  });

  it('rejects inconsistent actions, binary content and empty patches', () => {
    rejects([{ path: 'src/new.ts', action: 'modify', content: 'x' }], 'PATCH_INVALID');
    rejects([{ path: 'src/a.ts', action: 'create', content: 'x' }], 'PATCH_INVALID');
    rejects([{ path: 'src/a.ts', action: 'modify', content: 'a\0b' }], 'PATCH_INVALID');
    rejects([{ path: 'src/a.ts', action: 'modify', content: files['src/a.ts']! }], 'PATCH_EMPTY');
  });

  it('enforces the changed-file budget', () => {
    rejects(
      [
        { path: 'src/a.ts', action: 'modify', content: 'x' },
        { path: 'src/new.ts', action: 'create', content: 'y' },
      ],
      'PATCH_TOO_LARGE',
      { ...opts, maxChangedFiles: 1 },
    );
  });

  it('honours a plan-revision request', () => {
    expect(() => validatePatch({ summary: 's', plan_revision_needed: true, changes: [{ path: 'src/a.ts', action: 'modify', content: 'x', explanation: 'e' }] }, opts)).toThrow(/revised/);
  });
});
