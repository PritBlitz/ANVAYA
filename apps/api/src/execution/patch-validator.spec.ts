import { describe, expect, it } from 'vitest';
import { PatchRejected, composePatch, validatePatch } from './patch-validator.js';

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

  describe('composePatch (repairs)', () => {
    const A0 = 'export const a = 1;\n';
    const A1 = 'export const a = 42;\n';
    const N1 = 'export const n = 1;\n';
    // Attempt 1 changed a.ts and created new.ts (broken); the repair fixes only new.ts.
    const prior = [
      { path: 'src/a.ts', before: A0, after: A1, explanation: 'bump' },
      { path: 'src/new.ts', before: null, after: 'BROKEN\n', explanation: 'add' },
    ];
    const patched: Record<string, string> = { 'src/a.ts': A1, 'src/new.ts': 'BROKEN\n' };
    const repairOn = (workspace: Record<string, string>, changes: Array<{ path: string; action: 'modify' | 'create' | 'delete'; content?: string | null }>) =>
      validatePatch({ summary: 'repair', plan_revision_needed: false, changes: changes.map((c) => ({ explanation: 'fix', ...c })) }, { ...opts, current: (p) => workspace[p] ?? null });

    it('keeps files only the earlier attempt changed and diffs against the base commit', () => {
      const v = composePatch(prior, repairOn(patched, [{ path: 'src/new.ts', action: 'modify', content: N1 }]), 8);
      expect(v.changes.map((c) => [c.path, c.action, c.before, c.after])).toEqual([
        ['src/a.ts', 'modify', A0, A1],
        ['src/new.ts', 'create', null, N1],
      ]);
      expect(v.diff).toContain('--- /dev/null');
      expect(v.diff).not.toContain('BROKEN');
      expect(v.additions).toBe(2);
      expect(v.deletions).toBe(1);
      expect(v.summary).toBe('repair');
    });

    it('hashes the cumulative change like a first attempt with the same content would', () => {
      const v = composePatch(prior, repairOn(patched, [{ path: 'src/new.ts', action: 'modify', content: N1 }]), 8);
      const direct = validatePatch(
        {
          summary: 's',
          plan_revision_needed: false,
          changes: [
            { path: 'src/a.ts', action: 'modify', content: A1, explanation: 'x' },
            { path: 'src/new.ts', action: 'create', content: N1, explanation: 'x' },
          ],
        },
        opts,
      );
      expect(v.hash).toBe(direct.hash);
    });

    it('drops a file the repair restores to its base content, and rejects a repair that undoes everything', () => {
      const v = composePatch(prior, repairOn(patched, [{ path: 'src/a.ts', action: 'modify', content: A0 }]), 8);
      expect(v.changes.map((c) => c.path)).toEqual(['src/new.ts']);
      const undo = repairOn({ 'src/a.ts': A1 }, [{ path: 'src/a.ts', action: 'modify', content: A0 }]);
      expect(() => composePatch([prior[0]!], undo, 8)).toThrow(/does not change anything/);
    });

    it('applies the changed-file budget to the cumulative patch', () => {
      expect(() => composePatch(prior, repairOn(patched, [{ path: 'src/new.ts', action: 'modify', content: 'x\n' }]), 1)).toThrow(PatchRejected);
    });
  });
});
