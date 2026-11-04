import { createTwoFilesPatch, structuredPatch } from 'diff';
import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../common/crypto.js';
import { classifyPath, normalizePath } from '../indexing/classifier.js';

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

export const patchProposalSchema = z.object({
  summary: z.string().min(1).max(500),
  changes: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        action: z.enum(['modify', 'create', 'delete']),
        content: z.string().max(MAX_FILE_BYTES).nullable().optional(),
        explanation: z.string().max(500),
      }),
    )
    .min(1)
    .max(32),
  plan_revision_needed: z.boolean().default(false),
});
export type PatchProposal = z.infer<typeof patchProposalSchema>;

/** Paths a patch may never touch, regardless of plan: CI, VCS, credentials. */
const FORBIDDEN = [/^\.github\/workflows\//, /^\.git(\/|$)/, /^\.gitlab-ci\.yml$/, /(^|\/)\.circleci\//, /(^|\/)Jenkinsfile$/];

export interface ValidatedChange {
  path: string;
  action: 'modify' | 'create' | 'delete';
  before: string | null;
  after: string | null;
  explanation: string;
  additions: number;
  deletions: number;
}

export interface ValidatedPatch {
  summary: string;
  changes: ValidatedChange[];
  diff: string;
  hash: string;
  additions: number;
  deletions: number;
}

export class PatchRejected extends Error {
  constructor(
    readonly code: 'PATCH_OUT_OF_SCOPE' | 'PATCH_INVALID' | 'PATCH_TOO_LARGE' | 'PLAN_REVISION_REQUIRED' | 'PATCH_EMPTY',
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Validates a model-proposed patch before it is applied (FR-WF-006/007,
 * SECURITY §8): normalized paths, approved scope only, file-count and size
 * limits, forbidden paths, text content, and real changes.
 */
export function validatePatch(
  proposal: PatchProposal,
  opts: { allowedFiles: readonly string[]; maxChangedFiles: number; current: (path: string) => string | null },
): ValidatedPatch {
  if (proposal.plan_revision_needed) throw new PatchRejected('PLAN_REVISION_REQUIRED', 'The developer stage reported that the approved plan must be revised.');
  const allowed = new Set(opts.allowedFiles.map((p) => normalizePath(p)).filter((p): p is string => p !== null));
  const problems: string[] = [];
  const seen = new Set<string>();
  const changes: ValidatedChange[] = [];
  let bytes = 0;

  for (const c of proposal.changes) {
    const path = normalizePath(c.path);
    if (!path) {
      problems.push(`unsafe path: ${c.path.slice(0, 200)}`);
      continue;
    }
    if (seen.has(path)) {
      problems.push(`duplicate change for ${path}`);
      continue;
    }
    seen.add(path);
    if (!allowed.has(path)) problems.push(`not in the approved plan: ${path}`);
    if (FORBIDDEN.some((re) => re.test(path))) problems.push(`forbidden path: ${path}`);
    const cls = classifyPath(path, []);
    if (cls.excluded && (cls.reason === 'secret_file' || cls.reason === 'vcs_metadata' || cls.reason === 'binary_extension')) problems.push(`not editable (${cls.reason}): ${path}`);
    const before = opts.current(path);
    let after: string | null = null;
    if (c.action === 'delete') {
      if (before === null) problems.push(`cannot delete missing file: ${path}`);
    } else {
      if (typeof c.content !== 'string') {
        problems.push(`missing content for ${path}`);
        continue;
      }
      if (c.content.includes('\0')) problems.push(`binary content for ${path}`);
      if (c.action === 'create' && before !== null) problems.push(`file already exists: ${path}`);
      if (c.action === 'modify' && before === null) problems.push(`cannot modify missing file: ${path}`);
      after = keepFinalNewline(before, c.content);
      bytes += Buffer.byteLength(after);
    }
    if (before === after) continue; // no-op change
    const sp = structuredPatch(path, path, before ?? '', after ?? '', '', '', { context: 0 });
    const additions = sp.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('+')).length, 0);
    const deletions = sp.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('-')).length, 0);
    changes.push({ path, action: c.action, before, after, explanation: c.explanation, additions, deletions });
  }

  if (problems.some((p) => p.startsWith('not in the approved plan') || p.startsWith('forbidden') || p.startsWith('not editable'))) {
    throw new PatchRejected('PATCH_OUT_OF_SCOPE', 'The patch changes files outside the approved scope.', problems);
  }
  if (problems.length > 0) throw new PatchRejected('PATCH_INVALID', 'The patch failed validation.', problems);
  if (changes.length === 0) throw new PatchRejected('PATCH_EMPTY', 'The patch does not change anything.');
  if (changes.length > opts.maxChangedFiles) throw new PatchRejected('PATCH_TOO_LARGE', `The patch changes ${changes.length} files; the limit is ${opts.maxChangedFiles}.`);
  if (bytes > MAX_PATCH_BYTES) throw new PatchRejected('PATCH_TOO_LARGE', 'The patch exceeds the size limit.');
  return assemblePatch(proposal.summary, changes);
}

/** Models often drop the last newline of a file they rewrite; that is never the intended change. */
function keepFinalNewline(before: string | null, content: string): string {
  const wanted = before === null || before.endsWith('\n');
  return wanted && content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
}

const REWORDED_LINE_SIMILARITY = 0.5;
const words = (line: string) => new Set(line.match(/\w+/g) ?? []);

function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / (a.size + b.size - shared);
}

export interface RemovedLine {
  /** Line in the new file where the removal happened. */
  line: number;
  text: string;
}

/**
 * Lines of existing code a change dropped rather than edited or moved. A model
 * rewrites whole files, so it can lose code nobody asked it to touch, and the checks
 * still pass when no test covers that code. A removed line counts unless it survives
 * somewhere in the new file or an added line looks like a reworded version of it.
 */
export function removedCode(before: string, after: string): RemovedLine[] {
  const surviving = new Set(after.split('\n').map((l) => l.trim()));
  const hunks = structuredPatch('a', 'b', before, after, '', '', { context: 0 }).hunks;
  const added = hunks.flatMap((h) => h.lines.filter((l) => l.startsWith('+')).map((l) => words(l.slice(1))));
  const removed: RemovedLine[] = [];
  for (const h of hunks) {
    for (const raw of h.lines) {
      if (!raw.startsWith('-')) continue;
      const text = raw.slice(1).trim();
      const tokens = words(text);
      if (tokens.size === 0 || surviving.has(text)) continue;
      if (added.some((a) => similarity(tokens, a) >= REWORDED_LINE_SIMILARITY)) continue;
      removed.push({ line: Math.max(h.newStart, 1), text });
    }
  }
  return removed;
}

/** A file change from an earlier attempt, relative to the base commit. */
export interface PriorChange {
  path: string;
  before: string | null;
  after: string | null;
  explanation?: string | null;
}

/**
 * Composes a repair onto the patch it repairs. A repair is validated against the
 * workspace with the earlier patch applied, so on its own it is a delta; the stored
 * patch (what verification ran on, what is approved and what becomes the pull
 * request) must be cumulative against the base commit. For each path the base
 * content comes from the earlier patch when it touched the path, and the final
 * content from the repair when it touched it. Actions are re-derived from base and
 * final content; paths the repair restored to base drop out.
 */
export function composePatch(prior: readonly PriorChange[], repair: ValidatedPatch, maxChangedFiles: number): ValidatedPatch {
  const byPath = new Map<string, ValidatedChange>();
  for (const p of prior) {
    byPath.set(p.path, { path: p.path, action: 'modify', before: p.before, after: p.after, explanation: p.explanation ?? '', additions: 0, deletions: 0 });
  }
  for (const r of repair.changes) {
    const earlier = byPath.get(r.path);
    byPath.set(r.path, { ...r, before: earlier ? earlier.before : r.before });
  }
  const changes: ValidatedChange[] = [];
  for (const c of byPath.values()) {
    if (c.before === c.after) continue;
    const action = c.after === null ? 'delete' : c.before === null ? 'create' : 'modify';
    const sp = structuredPatch(c.path, c.path, c.before ?? '', c.after ?? '', '', '', { context: 0 });
    const additions = sp.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('+')).length, 0);
    const deletions = sp.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('-')).length, 0);
    changes.push({ ...c, action, additions, deletions });
  }
  if (changes.length === 0) throw new PatchRejected('PATCH_EMPTY', 'The repaired patch does not change anything.');
  if (changes.length > maxChangedFiles) throw new PatchRejected('PATCH_TOO_LARGE', `The patch changes ${changes.length} files; the limit is ${maxChangedFiles}.`);
  if (changes.reduce((n, c) => n + Buffer.byteLength(c.after ?? ''), 0) > MAX_PATCH_BYTES) throw new PatchRejected('PATCH_TOO_LARGE', 'The patch exceeds the size limit.');
  return assemblePatch(repair.summary, changes);
}

function assemblePatch(summary: string, changes: ValidatedChange[]): ValidatedPatch {
  changes.sort((a, b) => a.path.localeCompare(b.path));
  const diff = changes
    .map((c) =>
      createTwoFilesPatch(c.before === null ? '/dev/null' : `a/${c.path}`, c.after === null ? '/dev/null' : `b/${c.path}`, c.before ?? '', c.after ?? '', '', '', { context: 3 }).replace(/^=+\n/m, ''),
    )
    .join('');
  const hash = `sha256:${sha256Hex(canonicalJson(changes.map((c) => ({ path: c.path, action: c.action, after: c.after }))))}`;
  return {
    summary,
    changes,
    diff,
    hash,
    additions: changes.reduce((n, c) => n + c.additions, 0),
    deletions: changes.reduce((n, c) => n + c.deletions, 0),
  };
}
