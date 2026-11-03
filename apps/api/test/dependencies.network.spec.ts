import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppConfig } from '../src/config/config.js';
import { profileById } from '../src/execution/profiles.js';
import { DockerSandboxDriver } from '../src/execution/sandbox.js';

/**
 * B-4 against real Docker and the public registries. Opt-in (needs network):
 *   ANVAYA_NETWORK_TESTS=1 npx vitest run test/dependencies.network.spec.ts
 */
const enabled = process.env.ANVAYA_NETWORK_TESTS === '1';

function workspace(): { root: string; repo: string; deps: string } {
  const root = mkdtempSync(join(tmpdir(), 'anvaya-deps-'));
  const repo = join(root, 'repo');
  const deps = join(root, 'deps');
  for (const d of [repo, deps]) {
    mkdirSync(d);
    chmodSync(d, 0o777);
  }
  return { root, repo, deps };
}

describe.skipIf(!enabled)('dependency fetch + offline run (real Docker, real registries)', () => {
  const driver = new DockerSandboxDriver(new AppConfig({ ...process.env, SANDBOX_TIMEOUT_SECONDS: '120', SANDBOX_MEMORY_MB: '512' }));
  const roots: string[] = [];
  afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  it('npm: installs from the lockfile without running install scripts, then tests offline', async () => {
    const w = workspace();
    roots.push(w.root);
    writeFileSync(
      join(w.repo, 'package.json'),
      JSON.stringify({
        name: 'dep-test',
        version: '1.0.0',
        private: true,
        dependencies: { 'is-number': '7.0.0' },
        scripts: {
          preinstall: "node -e \"require('fs').writeFileSync('/deps/PWNED','1')\"",
          test: "node -e \"if(!require('is-number')(5))process.exit(1);console.log('dep-ok')\"",
        },
      }),
    );
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: w.repo, stdio: 'pipe', shell: process.platform === 'win32' });
    const profile = profileById('npm-test')!;
    const spec = profile.dependencies!;
    const prepared = await spec.prepare(w.repo);
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    for (const f of prepared.stage) copyFileSync(join(w.repo, f), join(w.deps, f));

    const fetched = await driver.fetch(spec, prepared.stage, w.repo, w.deps, { timeoutSeconds: 180 });
    expect(fetched.error).toBeNull();
    expect(fetched.exitCode, fetched.stderr + fetched.stdout).toBe(0);
    expect(existsSync(join(w.deps, 'node_modules', 'is-number', 'package.json'))).toBe(true);
    expect(existsSync(join(w.deps, 'PWNED'))).toBe(false); // install scripts never ran

    const run = await driver.run(profile, w.repo, { timeoutSeconds: 60, dependencies: { spec, dir: join(w.deps, 'node_modules') } });
    expect(run.stdout + run.stderr, run.stderr).toContain('dep-ok');
    expect(run.exitCode).toBe(0);
  }, 300_000);

  it('pip: installs wheels only, then runs pytest offline', async () => {
    const w = workspace();
    roots.push(w.root);
    writeFileSync(join(w.repo, 'requirements.txt'), 'pytest==8.3.3\n');
    writeFileSync(join(w.repo, 'test_math.py'), 'def test_add():\n    assert 1 + 1 == 2\n');
    const profile = profileById('python-pytest')!;
    const spec = profile.dependencies!;
    const prepared = await spec.prepare(w.repo);
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    for (const f of prepared.stage) copyFileSync(join(w.repo, f), join(w.deps, f));

    const fetched = await driver.fetch(spec, prepared.stage, w.repo, w.deps, { timeoutSeconds: 180 });
    expect(fetched.exitCode, fetched.stderr).toBe(0);
    expect(existsSync(join(w.deps, 'site', 'pytest'))).toBe(true);

    const run = await driver.run(profile, w.repo, { timeoutSeconds: 60, dependencies: { spec, dir: w.deps } });
    expect(run.stdout).toMatch(/1 passed/);
    expect(run.exitCode).toBe(0);
  }, 300_000);
});
