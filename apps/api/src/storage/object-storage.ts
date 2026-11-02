import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Global, Injectable, Module } from '@nestjs/common';
import { AppConfig } from '../config/config.js';

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,511}$/;

/**
 * Object storage for blobs, patches, logs and artifacts (DATABASE §1: large
 * content lives outside relational tables). Local filesystem driver for
 * development; the interface maps 1:1 to S3 for production.
 *
 * Keys are validated (lowercase, no traversal) and always resolved inside the
 * storage root.
 */
export abstract class ObjectStorage {
  abstract put(key: string, data: Buffer | string): Promise<void>;
  abstract get(key: string): Promise<Buffer | null>;
  abstract exists(key: string): Promise<boolean>;
  /** Deletes every object under a prefix (used by disconnect/retention). */
  abstract deletePrefix(prefix: string): Promise<void>;
}

export function assertKey(key: string): void {
  if (!KEY_RE.test(key) || key.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new Error(`invalid object key: ${key}`);
  }
}

@Injectable()
export class LocalObjectStorage extends ObjectStorage {
  private readonly root: string;

  constructor(config: AppConfig) {
    super();
    this.root = resolve(config.env.STORAGE_DIR);
  }

  private path(key: string): string {
    assertKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('object key escapes storage root');
    return p;
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.path(prefix.replace(/\/+$/, '')), { recursive: true, force: true });
  }
}

/** Content-addressed blob key for a repository file. */
export function blobKey(repositoryId: string, contentHash: string): string {
  const hex = contentHash.replace(/^sha256:/, '');
  return `repositories/${repositoryId}/blobs/${hex.slice(0, 2)}/${hex}`;
}

@Global()
@Module({ providers: [{ provide: ObjectStorage, useClass: LocalObjectStorage }], exports: [ObjectStorage] })
export class StorageModule {}
