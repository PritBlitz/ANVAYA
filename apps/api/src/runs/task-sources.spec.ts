import { describe, expect, it } from 'vitest';
import { clean, importCheckFailure, importPullRequest, safeUrl, untrustedSourceInputs } from './task-sources.js';

const pr = {
  number: 3,
  title: 'T',
  body: null,
  html_url: 'https://github.com/a/b/pull/3',
  state: 'open',
  head: { ref: 'feat', sha: 'a'.repeat(40) },
  base: { ref: 'main', sha: 'b'.repeat(40) },
  changed_files: 250,
  labels: [{ name: 'x' }, 'y', { name: '' }],
};

describe('task source import', () => {
  it('redacts and bounds text', () => {
    expect(clean(`key ghp_${'a'.repeat(36)}`, 100)).toBe('key [REDACTED_GITHUB_TOKEN]');
    const long = clean('z'.repeat(500), 100);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith('…[truncated]')).toBe(true);
  });

  it('keeps only http(s) links', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl('https://github.com/a/b')).toBe('https://github.com/a/b');
  });

  it('marks truncated pull request file lists and caps review comments by total size', () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified', additions: 1, deletions: 0 }));
    const comments = Array.from({ length: 30 }, () => ({ path: 'a.ts', line: 1, body: 'c'.repeat(1990), user: { login: 'r' } }));
    const out = importPullRequest(pr, files, comments, { files: 100, comments: 30 });
    const ctx = out.context as { changed_files_total: number; changed_files_truncated: boolean; review_comments: unknown[]; review_comments_truncated: boolean };
    expect(out.description).toBe('(no description)');
    expect(out.labels).toEqual(['x', 'y']);
    expect(ctx).toMatchObject({ changed_files_total: 250, changed_files_truncated: true, review_comments_truncated: true });
    expect(ctx.review_comments.length).toBeLessThan(30);
  });

  it('renders untrusted inputs within the AI service limits', () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ filename: `${'d/'.repeat(240)}${i}.ts`, status: 'modified', additions: 1, deletions: 0 }));
    const out = importPullRequest(pr, files, [], { files: 100, comments: 30 });
    const inputs = untrustedSourceInputs('pull_request', out.context);
    expect(inputs.map((i) => i.label)).toEqual(['github_pull_request_metadata']);
    for (const i of inputs) {
      expect(i.label).toMatch(/^[a-z_]{1,40}$/);
      expect(i.content.length).toBeLessThanOrEqual(20_000);
    }
    expect(untrustedSourceInputs('manual', {})).toEqual([]);
  });

  it('builds a failing-check task with a text external id and bounded annotations', () => {
    const check = {
      id: 99_000_000_000,
      name: 'build',
      head_sha: 'c'.repeat(40),
      status: 'completed',
      conclusion: 'failure',
      output: { title: null, summary: null, text: null, annotations_count: 80 },
      pull_requests: [{ number: 4 }],
    };
    const annotations = Array.from({ length: 60 }, () => ({ path: 'a.ts', start_line: 1, message: 'm'.repeat(5000) }));
    const out = importCheckFailure(check, annotations, { annotations: 50 });
    const ctx = out.context as { annotations: Array<{ message: string }>; annotations_truncated: boolean; pull_request_numbers: number[] };
    expect(out.externalId).toBe('99000000000');
    expect(out.description).toContain('concluded failure');
    expect(ctx.annotations).toHaveLength(50);
    expect(ctx.annotations[0]!.message.length).toBeLessThanOrEqual(1000);
    expect(ctx).toMatchObject({ annotations_truncated: true, pull_request_numbers: [4] });
    const inputs = untrustedSourceInputs('failing_check', out.context);
    expect(inputs[0]!.label).toBe('github_check_run_metadata');
    expect(inputs[0]!.content.length).toBeLessThanOrEqual(20_000);
  });
});
