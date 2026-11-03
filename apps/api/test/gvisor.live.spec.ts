import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppConfig } from '../src/config/config.js';
import { GvisorSandboxDriver } from '../src/execution/gvisor-sandbox.js';
import { profileById } from '../src/execution/profiles.js';

/**
 * Real gVisor checks, opt-in: they need runsc and a provisioned python rootfs.
 *
 *   ANVAYA_TEST_RUNSC=1
 *   SANDBOX_RUNSC_BIN, SANDBOX_RUNSC_PREFIX_ARGS, SANDBOX_ROOTFS_DIR, SANDBOX_STATE_DIR,
 *   SANDBOX_PATH_STYLE (wsl on a Windows host), SANDBOX_RUNSC_ROOTLESS — as the worker would use.
 *
 * Each case runs hostile code through the python-unittest profile and asserts gVisor contains it.
 */
const enabled = process.env.ANVAYA_TEST_RUNSC === '1';

describe.skipIf(!enabled)('gVisor sandbox against real runsc', () => {
  const driver = new GvisorSandboxDriver(new AppConfig({ ...process.env }));
  const profile = profileById('python-unittest')!;

  function workspace(test: string): string {
    const base = process.env.SANDBOX_TEST_WORKSPACES ?? tmpdir();
    const dir = mkdtempSync(path.join(base, 'anvaya-gv-live-'));
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests', '__init__.py'), '');
    writeFileSync(path.join(dir, 'tests', 'test_probe.py'), `import unittest\n\nclass Probe(unittest.TestCase):\n    def test_probe(self):\n${test.replace(/^/gm, '        ')}\n`);
    // Same permissions as WorkspaceManager: the sandbox user (65534) must be able to use them.
    for (const d of [dir, path.join(dir, 'tests')]) chmodSync(d, 0o777);
    for (const f of ['tests/__init__.py', 'tests/test_probe.py']) chmodSync(path.join(dir, f), 0o666);
    return dir;
  }

  async function probe(test: string) {
    return driver.run(profile, workspace(test), { timeoutSeconds: 120 });
  }

  it('runs a passing test and reports it', async () => {
    const res = await probe('self.assertEqual(1 + 1, 2)');
    expect(res.error).toBeNull();
    expect(res.exitCode).toBe(0);
  });

  it('runs inside gVisor as uid 65534', async () => {
    // gVisor's sentry implements the Linux ABI itself and names itself in the release (e.g. 4.19.0-gvisor).
    const res = await probe("import os\nself.assertEqual(os.getuid(), 65534)\nself.assertIn('gvisor', os.uname().release)");
    expect(res.exitCode, res.stderr).toBe(0);
  });

  it('has no network', async () => {
    const res = await probe("import socket\nwith self.assertRaises(OSError):\n    socket.create_connection(('1.1.1.1', 53), timeout=3)");
    expect(res.exitCode, res.stderr).toBe(0);
  });

  it('cannot write the root filesystem or execute from /tmp', async () => {
    const res = await probe("import os, stat, subprocess\nwith self.assertRaises(OSError):\n    open('/usr/evil', 'w')\nopen('/tmp/x.sh', 'w').write('#!/bin/sh\\necho hi')\nos.chmod('/tmp/x.sh', 0o755)\nwith self.assertRaises(OSError):\n    subprocess.run(['/tmp/x.sh'], check=True)");
    expect(res.exitCode, res.stderr).toBe(0);
  });

  it('sees no host environment', async () => {
    process.env.ANVAYA_HOST_SECRET = 'host-secret-value';
    const res = await probe("import os\nself.assertNotIn('ANVAYA_HOST_SECRET', os.environ)\nself.assertNotIn('DATABASE_URL', os.environ)");
    expect(res.exitCode, res.stderr).toBe(0);
  });

  it('enforces the PID limit against a fork bomb', async () => {
    // Children only pause, so they cost almost no memory: the PID limit, not the memory limit,
    // must stop the loop. They are reaped afterwards so the sandbox exits promptly.
    const res = await probe(
      [
        'import os, signal, sys',
        'def note(m):',
        '    sys.stderr.write("[probe] " + m + "\\n"); sys.stderr.flush()',
        'pids = []',
        'try:',
        '    with self.assertRaises(OSError) as raised:',
        '        for _ in range(5000):',
        '            pid = os.fork()',
        '            if pid == 0:',
        '                signal.pause()',
        '                os._exit(0)',
        '            pids.append(pid)',
        '            if len(pids) % 16 == 0: note("forked %d" % len(pids))',
        '    note("fork refused after %d: %r" % (len(pids), raised.exception))',
        'finally:',
        '    for p in pids:',
        '        os.kill(p, signal.SIGKILL)',
        '    for p in pids:',
        '        os.waitpid(p, 0)',
        '    note("reaped %d" % len(pids))',
        'self.assertLess(len(pids), 5000)',
      ].join('\n'),
    );
    const detail = JSON.stringify({ exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs, stdout: res.stdout.slice(-800), stderr: res.stderr.slice(-1500) });
    expect(res.error, detail).toBeNull();
    expect(res.exitCode, detail).toBe(0);
  });

  it('is killed at the wall-clock limit', async () => {
    const res = await driver.run(profile, workspace('import time\ntime.sleep(600)'), { timeoutSeconds: 5 });
    expect(res.timedOut).toBe(true);
  });
});
