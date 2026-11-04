import { describe, expect, it } from 'vitest';
import { profileById, selectProfiles, unavailableChecks } from './profiles.js';

describe('verification profile selection', () => {
  it('can narrow unittest runs to selected test files', () => {
    const selection = profileById('python-unittest')!.testSelection!;
    expect(selection.pattern.test('tests/test_core.py')).toBe(true);
    expect(selection.pattern.test('textstats/core.py')).toBe(false);
    expect(selection.argv(['tests/test_core.py'])).toEqual(['python', '-B', '-m', 'unittest', '-v', 'tests/test_core.py']);
  });

  it('reports checks the repository needs but no profile can run (FR-VER-005)', () => {
    const paths = new Set(['package.json', 'src/index.ts', 'api/pyproject.toml', 'svc/go.mod', 'lib/x.py']);
    const ids = unavailableChecks(paths).map((u) => u.profile_id);
    expect(ids).toEqual(['typescript-typecheck', 'npm-test', 'python-dependencies', 'go-test']);
    expect(unavailableChecks(paths).every((u) => u.reason.length > 10)).toBe(true);
    // The runnable profile is still selected; unavailable checks never replace it.
    expect(selectProfiles(undefined, paths).map((p) => p.id)).toContain('python-compile');
  });

  it('reports nothing for a repository fully covered by profiles', () => {
    expect(unavailableChecks(new Set(['app.py', 'test_app.py']))).toEqual([]);
  });
});
