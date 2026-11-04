/**
 * Turns GitHub pull requests and failing check runs into task context
 * (FR-WF-001, FR-GIT-006). Everything imported here is untrusted repository
 * content (CLAUDE.md §9): it is bounded, passed through secret redaction, stored
 * as data and only ever sent to a model as a labelled untrusted input.
 */
import { redactText } from '../common/redact.js';
import type { JsonObject } from '../database/types.js';
import type { GithubCheckAnnotation, GithubCheckRun, GithubPullRequest, GithubPullRequestFile, GithubReviewComment } from '../github/github-app.service.js';

export const TASK_TITLE_MAX = 300;
export const TASK_DESCRIPTION_MAX = 20_000;
/** Matches the AI service's per-input limit (UntrustedInput.content). */
export const UNTRUSTED_INPUT_MAX = 20_000;
const PATH_MAX = 500;
const COMMENT_MAX = 2_000;
const COMMENTS_TOTAL_MAX = 16_000;
const ANNOTATION_MAX = 1_000;
const CHECK_SUMMARY_MAX = 4_000;
const CHECK_TEXT_MAX = 8_000;
const CHECK_LOG_MAX = 6_000;
const BRANCH_MAX = 255;

/** Check conclusions that count as a failure worth a task. */
export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

/** Redacts, then truncates to `max` characters (marking truncation). */
export function clean(text: string | null | undefined, max: number): string {
  const redacted = redactText((text ?? '').replace(/\r\n/g, '\n')).trim();
  return redacted.length <= max ? redacted : `${redacted.slice(0, Math.max(0, max - 14))}\n…[truncated]`;
}

function labelNames(labels: GithubPullRequest['labels']): string[] {
  return labels
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .map((l) => l.trim().slice(0, 50))
    .filter(Boolean)
    .slice(0, 20);
}

export interface ImportedTask {
  title: string;
  description: string;
  labels: string[];
  externalId: string | null;
  sourceUrl: string | null;
  context: JsonObject;
}

export interface PullRequestContext {
  state: string;
  draft: boolean;
  merged: boolean;
  head_branch: string;
  head_sha: string;
  base_branch: string;
  base_sha: string;
  changed_files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  changed_files_total: number;
  changed_files_truncated: boolean;
  review_comments: Array<{ path: string | null; line: number | null; author: string | null; body: string }>;
  review_comments_truncated: boolean;
}

export function importPullRequest(pr: GithubPullRequest, files: GithubPullRequestFile[], comments: GithubReviewComment[], limits: { files: number; comments: number }): ImportedTask {
  const total = pr.changed_files ?? files.length;
  const nonEmpty = comments.filter((c) => c.body.trim()).length;
  let commentBudget = COMMENTS_TOTAL_MAX;
  const reviewComments: PullRequestContext['review_comments'] = [];
  for (const c of comments) {
    const body = clean(c.body, COMMENT_MAX);
    if (!body) continue;
    if (body.length > commentBudget) break;
    commentBudget -= body.length;
    reviewComments.push({ path: c.path ? clean(c.path, PATH_MAX) : null, line: c.line ?? null, author: c.user?.login.slice(0, 100) ?? null, body });
  }
  const context: PullRequestContext = {
    state: pr.merged ? 'merged' : pr.state.slice(0, 20),
    draft: pr.draft ?? false,
    merged: pr.merged ?? false,
    head_branch: clean(pr.head.ref, BRANCH_MAX),
    head_sha: pr.head.sha.slice(0, 64),
    base_branch: clean(pr.base.ref, BRANCH_MAX),
    base_sha: pr.base.sha.slice(0, 64),
    changed_files: files.slice(0, limits.files).map((f) => ({ path: clean(f.filename, PATH_MAX), status: f.status.slice(0, 20), additions: f.additions, deletions: f.deletions })),
    changed_files_total: Math.max(total, files.length),
    changed_files_truncated: total > files.length || files.length >= limits.files,
    review_comments: reviewComments,
    review_comments_truncated: comments.length >= limits.comments || reviewComments.length < nonEmpty,
  };
  return {
    title: clean(pr.title, TASK_TITLE_MAX) || `Pull request #${pr.number}`,
    description: clean(pr.body, TASK_DESCRIPTION_MAX) || '(no description)',
    labels: labelNames(pr.labels),
    externalId: null,
    sourceUrl: safeUrl(pr.html_url),
    context: context as unknown as JsonObject,
  };
}

export interface CheckFailureContext {
  check_name: string;
  app: string | null;
  conclusion: string;
  head_sha: string;
  started_at: string | null;
  completed_at: string | null;
  pull_request_numbers: number[];
  output_title: string | null;
  annotations: Array<{ path: string; start_line: number | null; end_line: number | null; level: string | null; title: string | null; message: string }>;
  annotations_total: number;
  annotations_truncated: boolean;
}

/** The part of an Actions log that explains the failure: up to the last error, without timestamps. */
export function failureLogTail(log: string): string {
  const lines = log
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\S*\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ''));
  const lastError = lines.findLastIndex((l) => l.includes('##[error]'));
  return (lastError >= 0 ? lines.slice(0, lastError + 1) : lines).join('\n').trim().slice(-CHECK_LOG_MAX);
}

export function importCheckFailure(check: GithubCheckRun, annotations: GithubCheckAnnotation[], limits: { annotations: number }, jobLog: string | null = null): ImportedTask {
  const context: CheckFailureContext = {
    check_name: clean(check.name, 200),
    app: check.app?.slug?.slice(0, 100) ?? check.app?.name?.slice(0, 100) ?? null,
    conclusion: (check.conclusion ?? 'unknown').slice(0, 30),
    head_sha: check.head_sha.slice(0, 64),
    started_at: check.started_at ?? null,
    completed_at: check.completed_at ?? null,
    pull_request_numbers: check.pull_requests.map((p) => p.number).slice(0, 10),
    output_title: check.output.title ? clean(check.output.title, 300) : null,
    annotations: annotations.slice(0, limits.annotations).map((a) => ({
      path: clean(a.path, PATH_MAX),
      start_line: a.start_line ?? null,
      end_line: a.end_line ?? null,
      level: a.annotation_level?.slice(0, 20) ?? null,
      title: a.title ? clean(a.title, 200) : null,
      message: clean(a.message, ANNOTATION_MAX),
    })),
    annotations_total: check.output.annotations_count,
    annotations_truncated: check.output.annotations_count > Math.min(annotations.length, limits.annotations),
  };
  const parts = [
    context.output_title ?? '',
    clean(check.output.summary, CHECK_SUMMARY_MAX),
    clean(check.output.text, CHECK_TEXT_MAX),
    jobLog ? `End of the job log:\n${clean(failureLogTail(jobLog), CHECK_LOG_MAX)}` : '',
  ].filter(Boolean);
  const description = boundChars(parts.join('\n\n'), TASK_DESCRIPTION_MAX) || `The check "${context.check_name}" concluded ${context.conclusion} with no output.`;
  return {
    title: clean(`Fix failing check: ${check.name}`, TASK_TITLE_MAX),
    description,
    labels: [],
    externalId: String(check.id),
    sourceUrl: check.html_url ? safeUrl(check.html_url) : null,
    context: context as unknown as JsonObject,
  };
}

function boundChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 14)}\n…[truncated]`;
}

/** Only http(s) links are kept; anything else (javascript:, data:) is dropped. */
export function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 2048) : null;
  } catch {
    return null;
  }
}

/**
 * Renders the imported metadata of a pull-request or failing-check task as
 * plain text for labelled untrusted model inputs. Empty for other sources.
 */
export function untrustedSourceInputs(sourceType: string, context: JsonObject): Array<{ label: string; content: string }> {
  if (sourceType === 'pull_request') {
    const c = context as Partial<PullRequestContext>;
    const lines = [
      `state: ${c.state ?? 'unknown'}${c.draft ? ' (draft)' : ''}`,
      `head: ${c.head_branch ?? '?'} @ ${c.head_sha ?? '?'}`,
      `base: ${c.base_branch ?? '?'} @ ${c.base_sha ?? '?'}`,
      `changed files (${c.changed_files_total ?? 0}${c.changed_files_truncated ? ', list truncated' : ''}):`,
      ...(c.changed_files ?? []).map((f) => `- ${f.status} ${f.path} (+${f.additions}/-${f.deletions})`),
    ];
    const out = [{ label: 'github_pull_request_metadata', content: lines.join('\n').slice(0, UNTRUSTED_INPUT_MAX) }];
    if (c.review_comments?.length) {
      const text = c.review_comments.map((r) => `[${r.author ?? 'unknown'} on ${r.path ?? 'general'}${r.line ? `:${r.line}` : ''}]\n${r.body}`).join('\n\n');
      out.push({ label: 'github_pull_request_review_comments', content: text.slice(0, UNTRUSTED_INPUT_MAX) });
    }
    return out;
  }
  if (sourceType === 'failing_check') {
    const c = context as Partial<CheckFailureContext>;
    const lines = [
      `check: ${c.check_name ?? '?'}${c.app ? ` (${c.app})` : ''}`,
      `conclusion: ${c.conclusion ?? 'unknown'}`,
      `head sha: ${c.head_sha ?? '?'}`,
      `annotations (${c.annotations_total ?? 0}${c.annotations_truncated ? ', truncated' : ''}):`,
      ...(c.annotations ?? []).map((a) => `- ${a.level ?? 'note'} ${a.path}${a.start_line ? `:${a.start_line}` : ''}${a.title ? ` ${a.title}` : ''}: ${a.message}`),
    ];
    return [{ label: 'github_check_run_metadata', content: lines.join('\n').slice(0, UNTRUSTED_INPUT_MAX) }];
  }
  return [];
}
