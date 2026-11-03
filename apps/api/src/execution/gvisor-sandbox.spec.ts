import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppConfig } from '../config/config.js';
import { npmSpec } from './dependencies.js';
import { GvisorSandboxDriver } from './gvisor-sandbox.js';
import { PROFILES } from './profiles.js';

const base = { DATABASE_URL: 'postgres://x', AI_SERVICE_TOKEN: 'x'.repeat(20) };
const profile = PROFILES[0]!;

/**
 * Stand-in for runsc: records every invocation, and for `run` reads the real bundle the driver
 * wrote. `sleep` as the profile's first argument hangs until `kill` drops a marker; exit code 128
 * as the first argument simulates a runtime failure.
 */
const FAKE_RUNSC = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// The driver starts the runtime with an empty environment, so the log path comes as an argument.
const [log, ...argv] = process.argv.slice(2);
appendFileSync(log, JSON.stringify(argv) + '\\n');
const cmdAt = argv.findIndex((a) => ['run', 'kill', 'delete'].includes(a));
const cmd = argv[cmdAt];
const id = argv[argv.length - 1 - (cmd === 'kill' ? 1 : 0)];
const marker = path.join(path.dirname(log), 'killed-' + id);
if (cmd === 'kill') { writeFileSync(marker, ''); process.exit(0); }
if (cmd === 'delete') process.exit(0);
const bundle = argv.find((a) => a.startsWith('--bundle=')).slice(9);
const spec = JSON.parse(readFileSync(path.join(bundle, 'config.json'), 'utf8'));
const first = spec.process.args[0];
if (first === 'exit128') process.exit(128);
if (first === 'sleep') { const t = setInterval(() => { if (existsSync(marker)) { clearInterval(t); process.exit(137); } }, 20); }
else { process.stdout.write('ran ' + spec.process.args.join(' ') + ' as ' + spec.process.user.uid + ' token=ghp_' + 'a'.repeat(36)); process.exit(0); }
`;

const dir = mkdtempSync(path.join(tmpdir(), 'anvaya-gvisor-'));
const rootfsDir = path.join(dir, 'rootfs');
const fake = path.join(dir, 'fake-runsc.mjs');
beforeAll(() => {
  writeFileSync(fake, FAKE_RUNSC);
});

function driver(env: Record<string, string> = {}) {
  return new GvisorSandboxDriver(
    new AppConfig({
      ...base,
      SANDBOX_RUNSC_BIN: process.execPath,
      SANDBOX_RUNSC_PREFIX_ARGS: JSON.stringify([fake, path.join(dir, 'calls.log')]),
      SANDBOX_ROOTFS_DIR: rootfsDir,
      SANDBOX_STATE_DIR: path.join(dir, 'state'),
      SANDBOX_MEMORY_MB: '512',
      SANDBOX_PIDS_LIMIT: '128',
      SANDBOX_CPUS: '1.5',
      ...env,
    }),
  );
}

function provision(d: GvisorSandboxDriver, image: string) {
  mkdirSync(d.rootfsFor(image), { recursive: true });
}

describe('gVisor sandbox spec', () => {
  const d = driver();
  const spec = d.spec(d.plan(profile, '/work/run-1'), '/rootfs/python');

  it('runs as nobody with no capabilities and no privilege escalation', () => {
    expect(spec.process.user).toEqual({ uid: 65534, gid: 65534 });
    expect(spec.process.noNewPrivileges).toBe(true);
    for (const set of Object.values(spec.process.capabilities)) expect(set).toEqual([]);
  });

  it('has a read-only root, a noexec /tmp, and the workspace as the only writable bind', () => {
    expect(spec.root).toEqual({ path: '/rootfs/python', readonly: true });
    const tmp = spec.mounts.find((m) => m.destination === '/tmp')!;
    expect(tmp.options).toEqual(expect.arrayContaining(['noexec', 'nosuid', 'nodev', 'size=64m']));
    const binds = spec.mounts.filter((m) => m.type === 'bind');
    expect(binds).toEqual([{ destination: '/workspace', type: 'bind', source: '/work/run-1', options: ['rbind', 'nosuid', 'nodev', 'rw'] }]);
  });

  it('isolates the network and process namespaces and applies resource limits', () => {
    expect(spec.linux.namespaces.map((n) => n.type)).toEqual(['pid', 'ipc', 'uts', 'mount', 'network']);
    // Guest processes: RLIMIT_NPROC at the configured 128. Host cgroup: headroom for gVisor itself.
    expect(spec.linux.resources).toEqual({ memory: { limit: 512 * 1024 * 1024, swap: 512 * 1024 * 1024 }, pids: { limit: 128 * 4 + 256 }, cpu: { quota: 150_000, period: 100_000 } });
    expect(spec.process.rlimits).toContainEqual({ type: 'RLIMIT_NPROC', hard: 128, soft: 128 });
    expect(spec.process.rlimits).toEqual(expect.arrayContaining([{ type: 'RLIMIT_NOFILE', hard: 1024, soft: 1024 }, { type: 'RLIMIT_CORE', hard: 0, soft: 0 }]));
  });

  it('passes no host environment through', () => {
    process.env.ANVAYA_SECRET_FOR_TEST = 'should-not-leak';
    const s = d.spec(d.plan(profile, '/w'), '/r');
    expect(s.process.env.join('\n')).not.toContain('should-not-leak');
    expect(s.process.env.every((v) => /^(PATH|HOME|CI|PYTHONDONTWRITEBYTECODE|NODE_OPTIONS)=/.test(v))).toBe(true);
    delete process.env.ANVAYA_SECRET_FOR_TEST;
  });

  it('mounts installed dependencies read-only', () => {
    const deps = npmSpec('node:22-alpine');
    const s = d.spec(d.plan(profile, '/w', { spec: deps, dir: '/deps/1' }), '/r');
    expect(s.mounts.find((m) => m.destination === deps.runMount)).toMatchObject({ source: '/deps/1', options: expect.arrayContaining(['ro']) });
  });

  it('keeps the workspace read-only and only the dependency directory writable in the fetch step', () => {
    const deps = npmSpec('node:22-alpine');
    const p = d.fetchPlan(deps, ['package.json'], '/w', '/deps/1');
    const s = d.spec(p, '/r');
    expect(s.mounts.find((m) => m.destination === '/workspace')!.options).toContain('ro');
    expect(s.mounts.find((m) => m.destination === deps.fetchMount)!.options).toContain('rw');
    expect(p.network).toBe('host');
    expect(s.linux.namespaces.map((n) => n.type)).not.toContain('network');
  });

  it('maps Windows paths for a WSL development worker only when asked', () => {
    expect(driver().runtimePath('/srv/x')).toBe('/srv/x');
    expect(driver({ SANDBOX_PATH_STYLE: 'wsl' }).runtimePath('Z:\\ANVAYA\\ws\\run-1')).toBe('/mnt/z/ANVAYA/ws/run-1');
    expect(driver({ SANDBOX_PATH_STYLE: 'wsl' }).runtimePath('C:/Users/x/run-2')).toBe('/mnt/c/Users/x/run-2');
  });

  it('passes runsc its state root, network mode and platform', () => {
    const args = driver({ SANDBOX_RUNSC_PREFIX_ARGS: '["-d","Ubuntu"]', SANDBOX_RUNSC_ROOTLESS: 'true' }).runscArgs('/state', 'none', ['run', 'x']);
    expect(args).toEqual(['-d', 'Ubuntu', '--root=/state', '--network=none', '--platform=systrap', '--rootless', 'run', 'x']);
  });
});

describe('gVisor sandbox execution (stand-in runsc)', () => {
  function logLines(): string[][] {
    const f = path.join(dir, 'calls.log');
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : [];
  }

  it('refuses an image that has not been provisioned, without starting the runtime', async () => {
    const before = logLines().length;
    const res = await driver().run({ ...profile, image: 'never/provisioned:1' }, dir, { timeoutSeconds: 5 });
    expect(res.error).toMatch(/not provisioned/);
    expect(logLines().length).toBe(before);
  });

  it('runs the profile, redacts output, then deletes the sandbox and its bundle', async () => {
    const d = driver();
    provision(d, profile.image);
    const res = await d.run(profile, dir, { timeoutSeconds: 10 });
    expect(res).toMatchObject({ exitCode: 0, timedOut: false, error: null });
    expect(res.stdout).toContain(`ran ${profile.argv.join(' ')} as 65534`);
    expect(res.stdout).not.toMatch(/ghp_a{36}/);
    const calls = logLines();
    const run = calls.find((c) => c.includes('run'))!;
    expect(run).toEqual(expect.arrayContaining(['--network=none', '--platform=systrap']));
    expect(calls.some((c) => c.includes('delete') && c.includes('--force'))).toBe(true);
    expect(readdirSync(path.join(dir, 'state', 'bundles'))).toEqual([]);
  });

  it('kills the sandbox on timeout and reports it', async () => {
    const d = driver();
    const sleeper = { ...profile, id: 'sleeper', argv: ['sleep', '600'] };
    provision(d, sleeper.image);
    const res = await d.run(sleeper, dir, { timeoutSeconds: 1 });
    expect(res.timedOut).toBe(true);
    expect(res.error).toBeNull();
    expect(logLines().some((c) => c.includes('kill') && c.includes('KILL'))).toBe(true);
  });

  it('kills the sandbox when the run is cancelled', async () => {
    const d = driver();
    const sleeper = { ...profile, id: 'sleeper', argv: ['sleep', '600'] };
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const res = await d.run(sleeper, dir, { timeoutSeconds: 30, signal: abort.signal });
    expect(res.exitCode).toBe(137);
    expect(res.timedOut).toBe(false);
  });

  it('reports runsc failures as infrastructure errors, not test failures', async () => {
    const res = await driver().run({ ...profile, argv: ['exit128'] }, dir, { timeoutSeconds: 10 });
    expect(res.error).toMatch(/gVisor runtime error/);
  });

  it('refuses the networked fetch step unless explicitly enabled', async () => {
    const res = await driver().fetch(npmSpec('node:22-alpine'), [], dir, dir, { timeoutSeconds: 5 });
    expect(res.error).toMatch(/SANDBOX_GVISOR_FETCH_NETWORK=host/);
  });
});

describe('gVisor driver configuration', () => {
  const prod = { ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true', AUTH_DEV_LOGIN_ENABLED: 'false', REPOSITORY_SOURCE: 'github' };

  it('is the approved production execution plane, unlike the Docker driver', () => {
    expect(() => new AppConfig({ ...prod, EXECUTION_DRIVER: 'gvisor' })).not.toThrow();
    expect(() => new AppConfig({ ...prod, EXECUTION_DRIVER: 'docker' })).toThrow(/not an approved production boundary/);
  });

  it('refuses development-only settings in production', () => {
    expect(() => new AppConfig({ ...prod, EXECUTION_DRIVER: 'gvisor', SANDBOX_PATH_STYLE: 'wsl' })).toThrow(/development workers only/);
    expect(() => new AppConfig({ ...prod, EXECUTION_DRIVER: 'gvisor', SANDBOX_GVISOR_FETCH_NETWORK: 'host' })).toThrow(/egress-allowlisting proxy/);
  });

  it('rejects a malformed runsc argv prefix', () => {
    expect(() => new AppConfig({ ...base, SANDBOX_RUNSC_PREFIX_ARGS: '"wsl"' })).toThrow(/JSON array of strings/);
  });
});
