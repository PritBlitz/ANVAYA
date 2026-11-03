import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/config.js';
import type { DependencySpec } from './dependencies.js';
import type { VerificationProfile } from './profiles.js';
import { runBounded, type RunOptions, SandboxDriver, type SandboxResult } from './sandbox.js';

/** The unprivileged identity every sandboxed process runs as (same as the Docker driver). */
const NOBODY = 65534;

/** Fixed, minimal environment. Nothing from the host is passed through. */
const BASE_ENV = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/tmp', 'CI=1', 'PYTHONDONTWRITEBYTECODE=1', 'NODE_OPTIONS=--max-old-space-size=512'];

export interface OciMount {
  destination: string;
  type: string;
  source: string;
  options: string[];
}

/** The subset of the OCI runtime spec (v1.1) that the sandbox sets. */
export interface OciSpec {
  ociVersion: string;
  process: {
    terminal: boolean;
    user: { uid: number; gid: number };
    args: string[];
    env: string[];
    cwd: string;
    noNewPrivileges: boolean;
    capabilities: { bounding: string[]; effective: string[]; inheritable: string[]; permitted: string[]; ambient: string[] };
    rlimits: Array<{ type: string; hard: number; soft: number }>;
  };
  root: { path: string; readonly: boolean };
  hostname: string;
  mounts: OciMount[];
  linux: {
    namespaces: Array<{ type: string }>;
    resources: { memory: { limit: number; swap: number }; pids: { limit: number }; cpu: { quota: number; period: number } };
    maskedPaths: string[];
    readonlyPaths: string[];
  };
}

export interface SandboxPlan {
  label: string;
  image: string;
  argv: readonly string[];
  /** 'none' runs with no network at all; 'host' is only for the dependency fetch step. */
  network: 'none' | 'host';
  binds: Array<{ source: string; destination: string; readonly: boolean }>;
  workdir: string;
  env: readonly string[];
  tmpfsMb: number;
}

/**
 * Production execution plane (SECURITY §7): every check runs under gVisor (`runsc`), a user-space
 * kernel that intercepts the sandboxed process's system calls, so repository code never talks to
 * the host kernel directly. On top of that it keeps the Docker driver's controls: no network,
 * read-only root filesystem, all capabilities dropped, no-new-privileges, non-root user, memory,
 * PID and CPU limits, file-size and descriptor rlimits, a noexec tmpfs, wall-clock timeout, and
 * bounded, redacted output. The only writable mount is the disposable per-run workspace.
 *
 * The worker needs no Docker daemon or socket: image root filesystems are provisioned ahead of
 * time under SANDBOX_ROOTFS_DIR (`scripts/sandbox/prepare-rootfs.sh`), one directory per image.
 */
@Injectable()
export class GvisorSandboxDriver extends SandboxDriver {
  constructor(private readonly config: AppConfig) {
    super();
  }

  /** `<SANDBOX_ROOTFS_DIR>/<image with every non [A-Za-z0-9._-] character replaced by _>`. */
  rootfsFor(image: string): string {
    return path.resolve(this.config.env.SANDBOX_ROOTFS_DIR, image.replace(/[^A-Za-z0-9._-]/g, '_'));
  }

  plan(profile: VerificationProfile, workspaceDir: string, deps?: RunOptions['dependencies']): SandboxPlan {
    return {
      label: profile.id,
      image: profile.image,
      argv: profile.argv,
      network: 'none',
      binds: [{ source: workspaceDir, destination: '/workspace', readonly: false }, ...(deps ? [{ source: deps.dir, destination: deps.spec.runMount, readonly: true }] : [])],
      workdir: '/workspace',
      env: deps?.spec.runEnv ?? [],
      tmpfsMb: 64,
    };
  }

  /**
   * The fetch step downloads dependencies and never runs repository code (B-4). gVisor has no
   * egress filtering of its own here, so the step is refused unless the operator opts in with
   * SANDBOX_GVISOR_FETCH_NETWORK=host and an egress-allowlisting proxy (SANDBOX_FETCH_PROXY).
   */
  fetchPlan(spec: DependencySpec, staged: readonly string[], workspaceDir: string, depsDir: string): SandboxPlan {
    const e = this.config.env;
    const proxy = e.SANDBOX_FETCH_PROXY ? [`HTTPS_PROXY=${e.SANDBOX_FETCH_PROXY}`, `HTTP_PROXY=${e.SANDBOX_FETCH_PROXY}`, `https_proxy=${e.SANDBOX_FETCH_PROXY}`, `http_proxy=${e.SANDBOX_FETCH_PROXY}`] : [];
    const ecosystemEnv =
      spec.ecosystem === 'npm'
        ? ['npm_config_registry=https://registry.npmjs.org/', 'npm_config_ignore_scripts=true', 'npm_config_cache=/tmp/npm-cache', 'npm_config_audit=false', 'npm_config_fund=false', 'npm_config_userconfig=/tmp/no-user-npmrc', 'npm_config_globalconfig=/tmp/no-global-npmrc']
        : ['PIP_CONFIG_FILE=/dev/null', 'PIP_NO_CACHE_DIR=1', 'PIP_ONLY_BINARY=:all:'];
    return {
      label: `fetch-${spec.ecosystem}`,
      image: spec.image,
      argv: spec.fetchArgv(staged),
      network: 'host',
      binds: [
        { source: workspaceDir, destination: '/workspace', readonly: true },
        { source: depsDir, destination: spec.fetchMount, readonly: false },
      ],
      workdir: spec.fetchWorkdir,
      env: [...ecosystemEnv, ...proxy],
      tmpfsMb: 512,
    };
  }

  /** Builds the OCI spec for a plan. Pure, so its security properties are unit-tested. */
  spec(p: SandboxPlan, rootfs: string): OciSpec {
    const e = this.config.env;
    const memory = e.SANDBOX_MEMORY_MB * 1024 * 1024;
    const period = 100_000;
    const noCaps: string[] = [];
    return {
      ociVersion: '1.1.0',
      process: {
        terminal: false,
        user: { uid: NOBODY, gid: NOBODY },
        args: [...p.argv],
        env: [...BASE_ENV, ...p.env],
        cwd: p.workdir,
        noNewPrivileges: true,
        capabilities: { bounding: noCaps, effective: noCaps, inheritable: noCaps, permitted: noCaps, ambient: noCaps },
        rlimits: [
          { type: 'RLIMIT_NOFILE', hard: 1024, soft: 1024 },
          { type: 'RLIMIT_FSIZE', hard: 104_857_600, soft: 104_857_600 },
          { type: 'RLIMIT_NPROC', hard: e.SANDBOX_PIDS_LIMIT, soft: e.SANDBOX_PIDS_LIMIT },
          { type: 'RLIMIT_CORE', hard: 0, soft: 0 },
        ],
      },
      root: { path: this.runtimePath(rootfs), readonly: true },
      hostname: 'sandbox',
      mounts: [
        { destination: '/proc', type: 'proc', source: 'proc', options: ['nosuid', 'noexec', 'nodev'] },
        { destination: '/dev', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'strictatime', 'mode=755', 'size=65536k'] },
        { destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: ['rw', 'noexec', 'nosuid', 'nodev', `size=${p.tmpfsMb}m`] },
        ...p.binds.map((b) => ({ destination: b.destination, type: 'bind', source: this.runtimePath(b.source), options: ['rbind', 'nosuid', 'nodev', b.readonly ? 'ro' : 'rw'] })),
      ],
      linux: {
        // A fresh network namespace with no interfaces is what makes `network: none` real.
        namespaces: [{ type: 'pid' }, { type: 'ipc' }, { type: 'uts' }, { type: 'mount' }, ...(p.network === 'none' ? [{ type: 'network' }] : [])],
        resources: { memory: { limit: memory, swap: memory }, pids: { limit: e.SANDBOX_PIDS_LIMIT }, cpu: { quota: Math.round(e.SANDBOX_CPUS * period), period } },
        maskedPaths: ['/proc/kcore', '/proc/keys', '/proc/timer_list', '/proc/sched_debug', '/sys/firmware'],
        readonlyPaths: ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'],
      },
    };
  }

  /** runsc global flags, then the command. */
  runscArgs(stateDir: string, network: SandboxPlan['network'], command: string[]): string[] {
    const e = this.config.env;
    return [
      ...e.SANDBOX_RUNSC_PREFIX_ARGS,
      `--root=${this.runtimePath(stateDir)}`,
      `--network=${network}`,
      `--platform=${e.SANDBOX_GVISOR_PLATFORM}`,
      ...(e.SANDBOX_RUNSC_ROOTLESS ? ['--rootless'] : []),
      ...command,
    ];
  }

  /**
   * Maps a path to how the runtime sees it. On a Linux worker this is the identity; a Windows
   * development worker that calls runsc inside WSL maps `Z:\x` to `/mnt/z/x` (SANDBOX_PATH_STYLE=wsl).
   */
  runtimePath(p: string): string {
    if (this.config.env.SANDBOX_PATH_STYLE !== 'wsl') return p;
    const abs = path.resolve(p);
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
    return m ? `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}` : abs.replace(/\\/g, '/');
  }

  async run(profile: VerificationProfile, workspaceDir: string, opts: RunOptions): Promise<SandboxResult> {
    return this.execute(this.plan(profile, workspaceDir, opts.dependencies), opts);
  }

  async fetch(spec: DependencySpec, staged: readonly string[], workspaceDir: string, depsDir: string, opts: { timeoutSeconds: number; signal?: AbortSignal }): Promise<SandboxResult> {
    if (this.config.env.SANDBOX_GVISOR_FETCH_NETWORK !== 'host') {
      return refused('dependency fetch under gVisor needs SANDBOX_GVISOR_FETCH_NETWORK=host and an egress-allowlisting SANDBOX_FETCH_PROXY');
    }
    return this.execute(this.fetchPlan(spec, staged, workspaceDir, depsDir), opts);
  }

  private async execute(p: SandboxPlan, opts: { timeoutSeconds: number; signal?: AbortSignal }): Promise<SandboxResult> {
    const rootfs = this.rootfsFor(p.image);
    if (!existsSync(rootfs)) return refused(`sandbox image ${p.image} is not provisioned (expected ${rootfs}; see scripts/sandbox/prepare-rootfs.sh)`);
    const id = `anvaya-sbx-${randomBytes(8).toString('hex')}`;
    const base = path.resolve(this.config.env.SANDBOX_STATE_DIR);
    const bundle = path.join(base, 'bundles', id);
    const stateDir = path.join(base, 'state');
    await mkdir(bundle, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(bundle, 'config.json'), JSON.stringify(this.spec(p, rootfs), null, 2), { mode: 0o600 });
    const bin = this.config.env.SANDBOX_RUNSC_BIN;
    const control = (command: string[]) =>
      new Promise<void>((resolve) => {
        const c = spawn(bin, this.runscArgs(stateDir, p.network, command), { shell: false, windowsHide: true });
        c.on('error', () => resolve());
        c.on('close', () => resolve());
      });
    return runBounded({
      label: p.label,
      bin,
      args: this.runscArgs(stateDir, p.network, ['run', `--bundle=${this.runtimePath(bundle)}`, id]),
      outputLimit: this.config.env.SANDBOX_OUTPUT_LIMIT_BYTES,
      timeoutSeconds: opts.timeoutSeconds,
      signal: opts.signal,
      kill: () => void control(['kill', '--all', id, 'KILL']),
      // runsc reports its own failures (bad bundle, platform, permissions) as exit 128 without
      // a signal. A sandboxed process killed by a signal exits 128+n, which is the profile's result.
      runtimeError: (code) => (code === 128 ? 'gVisor runtime error (exit 128)' : null),
      cleanup: async () => {
        await control(['delete', '--force', id]);
        await rm(bundle, { recursive: true, force: true });
      },
    });
  }
}

function refused(message: string): SandboxResult {
  return { exitCode: null, timedOut: false, durationMs: 0, stdout: '', stderr: '', truncated: false, error: message };
}
