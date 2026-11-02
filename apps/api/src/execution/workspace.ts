import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/config.js';
import { normalizePath } from '../indexing/classifier.js';
import type { SourceFile } from '../indexing/sources.js';

const MAX_WORKSPACE_BYTES = 300 * 1024 * 1024;

/**
 * Disposable per-run workspaces on the execution host. Source files are written
 * only as regular files under the workspace root after path normalization;
 * links, traversal and absolute paths are impossible to create. The directory
 * is world-writable so the non-root sandbox user can run tests in it, and is
 * removed when the run's execution finishes.
 */
@Injectable()
export class WorkspaceManager {
  private readonly root: string;

  constructor(config: AppConfig) {
    this.root = resolve(config.env.WORKSPACES_DIR);
  }

  dir(runId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error('invalid run id');
    return resolve(this.root, runId, 'repo');
  }

  /** Resolves a repository-relative path inside the workspace, rejecting any escape. */
  resolveInside(runId: string, relPath: string): string {
    const norm = normalizePath(relPath);
    if (!norm) throw new Error(`unsafe path: ${relPath}`);
    const base = this.dir(runId);
    const abs = resolve(base, norm);
    if (!abs.startsWith(base + sep)) throw new Error(`path escapes workspace: ${relPath}`);
    return abs;
  }

  async materialize(runId: string, files: SourceFile[]): Promise<{ written: number; skipped: number; paths: string[] }> {
    const base = this.dir(runId);
    await rm(resolve(this.root, runId), { recursive: true, force: true });
    await mkdir(base, { recursive: true, mode: 0o777 });
    await chmod(base, 0o777);
    let total = 0;
    let written = 0;
    let skipped = 0;
    const paths: string[] = [];
    for (const f of files) {
      const data = f.read();
      const norm = normalizePath(f.path);
      if (!data || !norm || norm.split('/')[0] === '.git') {
        skipped++;
        continue;
      }
      total += data.length;
      if (total > MAX_WORKSPACE_BYTES) throw new Error('workspace exceeds the size limit');
      const abs = this.resolveInside(runId, norm);
      await this.mkdirs(base, dirname(abs));
      await writeFile(abs, data, { mode: 0o666, flag: 'wx' });
      written++;
      paths.push(norm);
    }
    return { written, skipped, paths };
  }

  private async mkdirs(base: string, dir: string): Promise<void> {
    const rel = dir.slice(base.length).split(sep).filter(Boolean);
    let cur = base;
    for (const seg of rel) {
      cur = resolve(cur, seg);
      try {
        const st = await lstat(cur);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('unexpected non-directory in workspace');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        await mkdir(cur, { mode: 0o777 });
        await chmod(cur, 0o777);
      }
    }
  }

  async readText(runId: string, relPath: string): Promise<string | null> {
    try {
      const abs = this.resolveInside(runId, relPath);
      const st = await lstat(abs);
      if (!st.isFile()) return null;
      return await readFile(abs, 'utf8');
    } catch {
      return null;
    }
  }

  async writeText(runId: string, relPath: string, content: string): Promise<void> {
    const base = this.dir(runId);
    const abs = this.resolveInside(runId, relPath);
    await this.mkdirs(base, dirname(abs));
    try {
      const st = await lstat(abs);
      if (!st.isFile()) throw new Error('refusing to overwrite a non-regular file');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await writeFile(abs, content, { mode: 0o666 });
  }

  async remove(runId: string, relPath: string): Promise<void> {
    await rm(this.resolveInside(runId, relPath), { force: true });
  }

  async exists(runId: string): Promise<boolean> {
    try {
      return (await lstat(this.dir(runId))).isDirectory();
    } catch {
      return false;
    }
  }

  async cleanup(runId: string): Promise<void> {
    await rm(resolve(this.root, runId), { recursive: true, force: true });
  }
}
