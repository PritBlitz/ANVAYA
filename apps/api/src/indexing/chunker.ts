/** Line-aware chunking (FR-REP-005). Pure function. */

export const CHUNKER_VERSION = 'symbol-lines-v1';
export const MAX_CHUNK_LINES = 80;
export const MAX_CHUNK_CHARS = 6000;

export interface SymbolRange {
  name: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface Chunk {
  index: number;
  startLine: number;
  endLine: number;
  symbolName: string | null;
  kind: 'symbol' | 'block';
  content: string;
}

/**
 * Splits a file into chunks aligned to top-level symbols where possible.
 * Regions between symbols are chunked in fixed windows; blank-only windows are
 * dropped. Every chunk is bounded by lines and characters and keeps exact
 * 1-based line ranges, so citations map back to source precisely.
 */
export function chunkFile(text: string, symbols: SymbolRange[]): Chunk[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const total = lines.length;
  if (total === 0) return [];

  // Outermost symbols only, in order, non-overlapping.
  const sorted = [...symbols].filter((s) => s.startLine >= 1 && s.endLine <= total && s.endLine >= s.startLine).sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  const top: SymbolRange[] = [];
  for (const s of sorted) {
    const last = top.at(-1);
    if (!last || s.startLine > last.endLine) top.push(s);
  }

  const regions: Array<{ start: number; end: number; symbol: SymbolRange | null }> = [];
  let cursor = 1;
  for (const s of top) {
    if (s.startLine > cursor) regions.push({ start: cursor, end: s.startLine - 1, symbol: null });
    regions.push({ start: s.startLine, end: s.endLine, symbol: s });
    cursor = s.endLine + 1;
  }
  if (cursor <= total) regions.push({ start: cursor, end: total, symbol: null });

  const chunks: Chunk[] = [];
  for (const region of regions) {
    let start = region.start;
    while (start <= region.end) {
      let end = Math.min(region.end, start + MAX_CHUNK_LINES - 1);
      let content = lines.slice(start - 1, end).join('\n');
      while (content.length > MAX_CHUNK_CHARS && end > start) {
        end = start + Math.max(1, Math.floor((end - start + 1) / 2)) - 1;
        content = lines.slice(start - 1, end).join('\n');
      }
      if (content.length > MAX_CHUNK_CHARS) content = content.slice(0, MAX_CHUNK_CHARS);
      if (content.trim().length > 0) {
        chunks.push({
          index: chunks.length,
          startLine: start,
          endLine: end,
          symbolName: region.symbol?.qualifiedName ?? null,
          kind: region.symbol ? 'symbol' : 'block',
          content,
        });
      }
      start = end + 1;
    }
  }
  return chunks;
}

/** Text sent to the embedding model: provenance header + content. */
export function embeddingText(path: string, chunk: Pick<Chunk, 'symbolName' | 'content'>): string {
  return `File: ${path}${chunk.symbolName ? `\nSymbol: ${chunk.symbolName}` : ''}\n\n${chunk.content}`;
}
