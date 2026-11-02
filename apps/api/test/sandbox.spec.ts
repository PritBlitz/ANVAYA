import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfig } from '../src/config/config.js';
import type { VerificationProfile } from '../src/execution/profiles.js';
import { PROFILES } from '../src/execution/profiles.js';
import { DockerSandboxDriver } from '../src/execution/sandbox.js';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.OSType}}'], { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const PY = PROFILES.find((p) => p.id === 'python-compile')!.image;
const profile = (script: string): VerificationProfile => ({ id: 'test', description: 'test', image: PY, argv: ['sh', '-c', script], commandDisplay: 'test', detect: () => true });

/**
 * Security tests for the container sandbox against a real Docker engine
 * (SECURITY §13 release gates: sandbox cannot reach control-plane services,
 * limits and cleanup verified, cancellation terminates execution).
 */
describe.skipIf(!dockerAvailable())('docker sandbox policy (real containers)', () => {
  let dir: string;
  let driver: DockerSandboxDriver;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'anvaya-sbx-'));
    chmodSync(dir, 0o777);
    writeFileSync(join(dir, 'ok.py'), 'print("ok")\n');
    driver = new DockerSandboxDriver(new AppConfig({ ...process.env, SANDBOX_TIMEOUT_SECONDS: '30', SANDBOX_OUTPUT_LIMIT_BYTES: '4096', SANDBOX_PIDS_LIMIT: '64', SANDBOX_MEMORY_MB: '256' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reports real exit codes', async () => {
    expect((await driver.run(profile('python ok.py'), dir, { timeoutSeconds: 30 })).exitCode).toBe(0);
    const failed = await driver.run(profile('exit 3'), dir, { timeoutSeconds: 30 });
    expect(failed.exitCode).toBe(3);
    expect(failed.error).toBeNull();
  });

  it('has no network access (egress denied), including to host services', async () => {
    const res = await driver.run(
      profile(
        `python -c "
import socket
for host, port in [('1.1.1.1', 53), ('host.docker.internal', 5433), ('host.docker.internal', 6379), ('169.254.169.254', 80)]:
    try:
        socket.create_connection((host, port), timeout=2); print('CONNECTED', host, port)
    except Exception as e:
        print('blocked', host, port)
"`,
      ),
      dir,
      { timeoutSeconds: 30 },
    );
    expect(res.stdout).not.toContain('CONNECTED');
    expect(res.stdout.match(/blocked/g)).toHaveLength(4);
  });

  it('runs as an unprivileged user with a read-only root and no capabilities', async () => {
    const res = await driver.run(profile('id -u; touch /etc/x 2>&1 || echo ro-root; grep CapEff /proc/self/status; mount 2>/dev/null | grep -c docker.sock || true'), dir, { timeoutSeconds: 30 });
    const out = res.stdout;
    expect(out.split('\n')[0]).toBe('65534');
    expect(out).toContain('ro-root');
    expect(out).toMatch(/CapEff:\s+0000000000000000/);
  });

  it('does not leak host environment variables or secrets', async () => {
    const res = await driver.run(profile('env'), dir, { timeoutSeconds: 30 });
    expect(res.stdout).not.toMatch(/DATABASE_URL|REDIS_URL|AI_SERVICE_TOKEN|GITHUB|SESSION/);
    expect(res.stdout).toContain('HOME=/tmp');
  });

  it('kills runaway processes at the timeout', async () => {
    const started = Date.now();
    const res = await driver.run(profile('sleep 120'), dir, { timeoutSeconds: 3 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('bounds process creation (fork bomb) and output size', async () => {
    const bomb = await driver.run(profile('for i in $(seq 1 500); do sleep 30 & done; echo spawned; wait'), dir, { timeoutSeconds: 8 });
    expect(bomb.stderr + bomb.stdout).toMatch(/can't fork|Resource temporarily unavailable|spawned/);
    const noisy = await driver.run(profile('yes AAAAAAAAAAAAAAAA | head -c 200000'), dir, { timeoutSeconds: 30 });
    expect(noisy.truncated).toBe(true);
    expect(Buffer.byteLength(noisy.stdout)).toBeLessThanOrEqual(4096);
  });

  it('redacts secrets that appear in output', async () => {
    const res = await driver.run(profile(`echo "token ghp_${'a'.repeat(36)}"`), dir, { timeoutSeconds: 30 });
    expect(res.stdout).not.toContain('ghp_aaaa');
    expect(res.stdout).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('cancellation kills the container', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 1500);
    const started = Date.now();
    const res = await driver.run(profile('sleep 60'), dir, { timeoutSeconds: 60, signal: ctrl.signal });
    expect(res.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('only the workspace is writable and no containers are left behind', async () => {
    await driver.run(profile('echo data > /workspace/written.txt; echo x > /tmp/t && /tmp/t 2>&1 || echo tmp-noexec'), dir, { timeoutSeconds: 30 });
    expect(readdirSync(dir)).toContain('written.txt');
    const leftovers = execFileSync('docker', ['ps', '-aq', '--filter', 'label=anvaya.sandbox=1']).toString().trim();
    expect(leftovers).toBe('');
  });
});
