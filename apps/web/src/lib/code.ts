/** Helpers for line ranges, citations, and term highlighting. Pure and unit-tested. */

export interface LineRange {
  start: number;
  end: number;
}

/** Parse "24-51", "24", "L24-L51" into a range. Returns null if invalid. */
export function parseLineRange(value: string | null | undefined): LineRange | null {
  if (!value) return null;
  const m = value.trim().match(/^L?(\d+)(?:\s*[-–:]\s*L?(\d+))?$/i);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (!Number.isInteger(start) || start < 1 || end < start) return null;
  return { start, end };
}

export function formatLineParam(range: LineRange): string {
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
}

export function codeHref(
  base: string,
  repoId: string,
  path: string,
  range?: LineRange | null,
  commitSha?: string | null,
): string {
  const params = new URLSearchParams({ path });
  if (range) params.set("lines", formatLineParam(range));
  if (commitSha) params.set("commit", commitSha);
  return `${base}/repositories/${repoId}/code?${params.toString()}`;
}

export function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Extract search terms worth highlighting from a natural-language query. */
export function highlightTerms(query: string): string[] {
  const stop = new Set([
    "the",
    "and",
    "for",
    "are",
    "with",
    "that",
    "this",
    "where",
    "what",
    "when",
    "how",
    "does",
    "from",
    "into",
    "which",
    "handled",
    "handle",
    "is",
    "of",
    "to",
    "in",
    "on",
  ]);
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length >= 3 && !stop.has(t)),
    ),
  ];
}

export interface TextSegment {
  text: string;
  match: boolean;
}

/** Split text into segments marking case-insensitive occurrences of any term. */
export function segmentMatches(text: string, terms: string[]): TextSegment[] {
  if (!terms.length || !text) return [{ text, match: false }];
  const escaped = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: text.slice(last, idx), match: false });
    out.push({ text: m[0], match: true });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false });
  return out;
}

/** Answer text uses [n] markers that refer to citations (1-based). */
export function citationMarkers(text: string): number[] {
  return [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
}
