import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import tarStream from 'tar-stream';
import { AppConfig } from '../config/config.js';
import type { Repository } from '../database/types.js';
import { GithubAppService } from '../github/github-app.service.js';
import { normalizePath } from './classifier.js';

export interface SourceFile {
  path: string;
  size: number;
  /** Returns bytes only for regular files within the size limit; null otherwise. */
  read: () => Buffer | null;
}

export interface SourceSnapshot {
  commitSha: string;
  /** Regular files only. Symlinks/hardlinks/devices are reported as skipped. */
  files: SourceFile[];
  skipped: Array<{ path: string; reason: 'symlink' | 'special_file' | 'invalid_path' }>;
  truncated: boolean;
}

export interface SourceLimits {
  maxArchiveBytes: number;
  maxFiles: number;
  maxFileBytes: number;
}

export type SourceRepository = Repository & { external_installation_id: number | null };

export abstract class RepositorySource {
  abstract resolveCommit(repo: SourceRepository, ref: string | null): Promise<string>;
  abstract fetch(repo: SourceRepository, commitSha: string, limits: SourceLimits): Promise<SourceSnapshot>;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Parses a gzipped tarball fully in memory. Nothing is ever written to disk,
 * so archive path traversal and symlink tricks have no filesystem to act on;
 * links and special entries are skipped and reported.
 */
export async function readTarball(gz: Buffer, limits: SourceLimits): Promise<Omit<SourceSnapshot, 'commitSha'>> {
  const extract = tarStream.extract();
  const files: SourceFile[] = [];
  const skipped: SourceSnapshot['skipped'] = [];
  let truncated = false;
  let total = 0;
  const done = new Promise<void>((resolveDone, reject) => {
    extract.on('entry', (header, stream, next) => {
      // GitHub archives have a single top-level directory "<owner>-<repo>-<sha>/".
      const stripped = header.name.split('/').slice(1).join('/');
      const path = normalizePath(stripped);
      const finish = () => {
        stream.resume();
        stream.on('end', next);
      };
      if (header.type === 'directory' || stripped === '') return finish();
      if (!path) {
        skipped.push({ path: stripped.slice(0, 300), reason: 'invalid_path' });
        return finish();
      }
      if (header.type === 'symlink' || header.type === 'link') {
        skipped.push({ path, reason: 'symlink' });
        return finish();
      }
      if (header.type !== 'file') {
        skipped.push({ path, reason: 'special_file' });
        return finish();
      }
      if (files.length >= limits.maxFiles) {
        truncated = true;
        return finish();
      }
      const size = header.size ?? 0;
      if (size > limits.maxFileBytes) {
        files.push({ path, size, read: () => null });
        return finish();
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: unknown) => {
        if (!Buffer.isBuffer(c)) return;
        total += c.length;
        chunks.push(c);
      });
      stream.on('end', () => {
        const data = Buffer.concat(chunks);
        files.push({ path, size, read: () => data });
        if (total > limits.maxArchiveBytes) extract.destroy(new Error('archive exceeds the configured size limit'));
        else next();
      });
    });
    extract.on('finish', resolveDone);
    extract.on('error', reject);
  });
  const gunzip = createGunzip({ maxOutputLength: limits.maxArchiveBytes * 4 });
  gunzip.on('error', (e) => extract.destroy(e));
  Readable.from(gz).pipe(gunzip).pipe(extract);
  await done;
  return { files, skipped, truncated };
}

@Injectable()
export class GithubRepositorySource extends RepositorySource {
  constructor(private readonly github: GithubAppService) {
    super();
  }

  private installationId(repo: SourceRepository): number {
    if (!repo.external_installation_id) throw Object.assign(new Error('repository has no active installation'), { transient: false });
    return repo.external_installation_id;
  }

  async resolveCommit(repo: SourceRepository, ref: string | null): Promise<string> {
    if (ref && SHA_RE.test(ref)) return ref;
    return this.github.resolveBranchSha(this.installationId(repo), repo.external_repository_id, repo.full_name, ref ?? repo.default_branch ?? 'main');
  }

  async fetch(repo: SourceRepository, commitSha: string, limits: SourceLimits): Promise<SourceSnapshot> {
    const inst = this.installationId(repo);
    const gz = await this.github.downloadTarball(inst, repo.external_repository_id, repo.full_name, commitSha, limits.maxArchiveBytes);
    return { commitSha, ...(await readTarball(gz, limits)) };
  }
}

/**
 * Development-only source: reads `LOCAL_FIXTURE_ROOT/<owner>/<name>/` as a
 * working tree. The commit SHA is a deterministic content digest. Refused in
 * production by configuration validation. Symlinks are never followed.
 */
@Injectable()
export class LocalFixtureSource extends RepositorySource {
  constructor(private readonly config: AppConfig) {
    super();
  }

  private root(repo: Repository): string {
    const base = resolve(this.config.env.LOCAL_FIXTURE_ROOT ?? '.');
    const dir = resolve(base, repo.owner, repo.name);
    if (!dir.startsWith(base + sep)) throw new Error('fixture path escapes root');
    return dir;
  }

  async resolveCommit(repo: Repository): Promise<string> {
    const snap = await this.walk(this.root(repo), { maxArchiveBytes: 500 * 1024 * 1024, maxFiles: 50_000, maxFileBytes: 10 * 1024 * 1024 });
    const h = createHash('sha1');
    for (const f of [...snap.files].sort((a, b) => a.path.localeCompare(b.path))) h.update(f.path).update('\0').update(f.read() ?? Buffer.from(String(f.size))).update('\0');
    return h.digest('hex');
  }

  async fetch(repo: Repository, commitSha: string, limits: SourceLimits): Promise<SourceSnapshot> {
    return { commitSha, ...(await this.walk(this.root(repo), limits)) };
  }

  private async walk(root: string, limits: SourceLimits): Promise<Omit<SourceSnapshot, 'commitSha'>> {
    const files: SourceFile[] = [];
    const skipped: SourceSnapshot['skipped'] = [];
    let truncated = false;
    const visit = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        const rel = relative(root, abs).split(sep).join('/');
        if (entry.name === '.git') continue;
        const st = await lstat(abs);
        if (st.isSymbolicLink()) {
          skipped.push({ path: rel, reason: 'symlink' });
        } else if (st.isDirectory()) {
          await visit(abs);
        } else if (st.isFile()) {
          if (files.length >= limits.maxFiles) {
            truncated = true;
            continue;
          }
          const data = st.size <= limits.maxFileBytes ? await readFile(abs) : null;
          files.push({ path: rel, size: st.size, read: () => data });
        } else {
          skipped.push({ path: rel, reason: 'special_file' });
        }
      }
    };
    await visit(root);
    return { files, skipped, truncated };
  }
}
