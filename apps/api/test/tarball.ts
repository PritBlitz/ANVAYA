import { gzipSync } from 'node:zlib';
import tarStream from 'tar-stream';

export type TarEntry = { name: string; content: string | Buffer } | { name: string; symlinkTo: string };

/** Builds a GitHub-style gzipped tarball with a single top-level directory. */
export async function buildTarball(prefix: string, entries: TarEntry[]): Promise<Buffer> {
  const pack = tarStream.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (c: unknown) => {
    if (Buffer.isBuffer(c)) chunks.push(c);
  });
  const done = new Promise<void>((resolve, reject) => {
    pack.on('end', resolve);
    pack.on('error', reject);
  });
  pack.entry({ name: `${prefix}/`, type: 'directory' });
  for (const e of entries) {
    if ('symlinkTo' in e) pack.entry({ name: `${prefix}/${e.name}`, type: 'symlink', linkname: e.symlinkTo });
    else pack.entry({ name: e.name.startsWith('RAW:') ? e.name.slice(4) : `${prefix}/${e.name}` }, e.content);
  }
  pack.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}
