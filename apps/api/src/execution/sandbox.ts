import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { logger } from '../common/logger.js';
import { metrics } from '../common/metrics.js';
import { redactText } from '../common/redact.js';
import { AppConfig } from '../config/config.js';
import type { VerificationProfile } from './profiles.js';

const log = logger('sandbox');

export interface SandboxResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** The infrastructure failed (not the profile). */
  error: string | null;
}

export abstract class SandboxDriver {
  abstract run(profile: VerificationProfile, workspaceDir: string, opts: { timeoutSeconds: number; signal?: AbortSignal }): Promise<SandboxResult>;
}

/**
 * Hardened container driver for local development (SECURITY §7 baseline):
 * no network, read-only root FS, all capabilities dropped, no-new-privileges,
 * non-root, PID/memory/CPU limits, noexec tmpfs, wall-clock timeout, bounded
 * and redacted output, no environment passthrough, no Docker socket, and the
 * only writable mount is the disposable per-run workspace.
 *
 * A container is NOT a sufficient boundary for hostile multi-tenant code; the
 * production driver must be a microVM / dedicated sandbox service.
 */
@Injectable()
export class DockerSandboxDriver extends SandboxDriver {
  constructor(private readonly config: AppConfig) {
    super();
  }

  buildArgs(name: string, profile: VerificationProfile, workspaceDir: string): string[] {
    const e = this.config.env;
    return [
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(e.SANDBOX_PIDS_LIMIT),
      '--memory',
      `${e.SANDBOX_MEMORY_MB}m`,
      '--memory-swap',
      `${e.SANDBOX_MEMORY_MB}m`,
      '--cpus',
      String(e.SANDBOX_CPUS),
      '--ulimit',
      'nofile=1024:1024',
      '--ulimit',
      'fsize=104857600:104857600',
      '--user',
      '65534:65534',
      '--mount',
      `type=bind,src=${workspaceDir},dst=/workspace`,
      '--workdir',
      '/workspace',
      // Fixed, minimal environment. Nothing from the host is passed through.
      '--env',
      'HOME=/tmp',
      '--env',
      'CI=1',
      '--env',
      'PYTHONDONTWRITEBYTECODE=1',
      '--env',
      'NODE_OPTIONS=--max-old-space-size=512',
      '--label',
      'anvaya.sandbox=1',
      profile.image,
      ...profile.argv,
    ];
  }

  async run(profile: VerificationProfile, workspaceDir: string, opts: { timeoutSeconds: number; signal?: AbortSignal }): Promise<SandboxResult> {
    const limit = this.config.env.SANDBOX_OUTPUT_LIMIT_BYTES;
    const name = `anvaya-sbx-${randomBytes(8).toString('hex')}`;
    const args = this.buildArgs(name, profile, workspaceDir);
    const started = Date.now();
    return new Promise<SandboxResult>((resolve) => {
      // argv array, no shell: nothing here is interpolated into a command line.
      const child = spawn(this.config.env.SANDBOX_DOCKER_BIN, args, { shell: false, windowsHide: true, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const collect = (chunks: Buffer[], size: number, c: Buffer): number => {
        const room = limit - size;
        if (room <= 0) {
          truncated = true;
          return size;
        }
        if (c.length > room) truncated = true;
        chunks.push(c.subarray(0, room));
        return size + Math.min(c.length, room);
      };
      child.stdout.on('data', (c: Buffer) => (outBytes = collect(out, outBytes, c)));
      child.stderr.on('data', (c: Buffer) => (errBytes = collect(err, errBytes, c)));
      const kill = () => {
        spawn(this.config.env.SANDBOX_DOCKER_BIN, ['kill', name], { shell: false, windowsHide: true }).on('error', () => undefined);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutSeconds * 1000);
      const onAbort = () => kill();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (exitCode: number | null, error: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        const result: SandboxResult = {
          exitCode,
          timedOut,
          durationMs: Date.now() - started,
          stdout: redactText(Buffer.concat(out).toString('utf8')),
          stderr: redactText(Buffer.concat(err).toString('utf8')),
          truncated,
          error,
        };
        log.info({ profile: profile.id, exit_code: exitCode, timed_out: timedOut, duration_ms: result.durationMs, truncated }, 'sandbox finished');
        metrics.sandboxRuns.inc({ profile: profile.id, status: error ? 'error' : timedOut ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed' });
        metrics.sandboxDuration.observe({ profile: profile.id }, result.durationMs / 1000);
        resolve(result);
      };
      child.on('error', (e) => finish(null, `sandbox driver failed to start: ${e.message}`));
      // docker exits 125-127 for its own failures (daemon, image, command not found).
      child.on('close', (code) => finish(code, code !== null && code >= 125 && code <= 127 && !timedOut ? `container runtime error (exit ${code})` : null));
    });
  }
}
