import { createSign } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z, type ZodType } from 'zod';
import { Errors } from '../common/errors.js';
import { logger } from '../common/logger.js';
import { AppConfig } from '../config/config.js';

const log = logger('github-app');

export type GithubPermissionLevel = 'read' | 'write';
export type GithubPermissions = Partial<Record<'contents' | 'metadata' | 'pull_requests' | 'issues' | 'checks', GithubPermissionLevel>>;

/** Least-privilege permission sets requested per operation (SECURITY §6). */
export const PERMISSION_SETS = {
  read: { contents: 'read', metadata: 'read' },
  readIssues: { contents: 'read', metadata: 'read', issues: 'read', pull_requests: 'read' },
  readIssue: { metadata: 'read', issues: 'read' },
  readPullRequest: { metadata: 'read', pull_requests: 'read' },
  readChecks: { metadata: 'read', checks: 'read' },
  writePullRequest: { contents: 'write', metadata: 'read', pull_requests: 'write' },
} as const satisfies Record<string, GithubPermissions>;

export const githubAccount = z.object({ login: z.string(), id: z.number().int(), type: z.string().optional() });

export const githubInstallation = z.object({
  id: z.number().int(),
  account: githubAccount.nullable(),
  permissions: z.record(z.string(), z.string()).default({}),
  repository_selection: z.enum(['all', 'selected']).optional(),
  suspended_at: z.string().nullable().optional(),
});
export type GithubInstallation = z.infer<typeof githubInstallation>;

export const githubRepository = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  owner: githubAccount,
  private: z.boolean(),
  visibility: z.enum(['public', 'private', 'internal']).optional(),
  default_branch: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  size: z.number().optional(),
});
export type GithubRepository = z.infer<typeof githubRepository>;

const installationToken = z.object({ token: z.string().min(1), expires_at: z.string() });
const installationRepos = z.object({ total_count: z.number().int(), repositories: z.array(githubRepository) });
const userInstallations = z.object({ total_count: z.number().int(), installations: z.array(z.object({ id: z.number().int() })) });
export const githubIssue = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  state: z.string(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string().optional() })])).default([]),
  pull_request: z.unknown().optional(),
});
export type GithubIssue = z.infer<typeof githubIssue>;

const ref = z.object({ ref: z.string(), sha: z.string() });
export const githubPullRequest = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  head: ref,
  base: ref,
  changed_files: z.number().int().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string().optional() })])).default([]),
});
export type GithubPullRequest = z.infer<typeof githubPullRequest>;
export const githubPullRequestFile = z.object({ filename: z.string(), status: z.string(), additions: z.number().int().default(0), deletions: z.number().int().default(0) });
export type GithubPullRequestFile = z.infer<typeof githubPullRequestFile>;
export const githubReviewComment = z.object({
  path: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
  body: z.string().default(''),
  user: z.object({ login: z.string() }).nullable().optional(),
});
export type GithubReviewComment = z.infer<typeof githubReviewComment>;
export const githubCheckRun = z.object({
  id: z.number().int(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  output: z
    .object({
      title: z.string().nullable().optional(),
      summary: z.string().nullable().optional(),
      text: z.string().nullable().optional(),
      annotations_count: z.number().int().default(0),
    })
    .default({ annotations_count: 0 }),
  app: z.object({ slug: z.string().optional(), name: z.string().optional() }).nullable().optional(),
  pull_requests: z.array(z.object({ number: z.number().int() })).default([]),
});
export type GithubCheckRun = z.infer<typeof githubCheckRun>;
export const githubCheckAnnotation = z.object({
  path: z.string(),
  start_line: z.number().int().nullable().optional(),
  end_line: z.number().int().nullable().optional(),
  annotation_level: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
});
export type GithubCheckAnnotation = z.infer<typeof githubCheckAnnotation>;
const checkRunList = z.object({ total_count: z.number().int(), check_runs: z.array(githubCheckRun) });

/** Bounds on what is read from GitHub for one task import (CLAUDE.md §9). */
export const IMPORT_LIMITS = { prFiles: 100, reviewComments: 30, annotations: 50, checkRuns: 50 } as const;

const pullRequestSchema = z.object({ id: z.number().int(), number: z.number().int(), html_url: z.string(), head: z.object({ sha: z.string(), ref: z.string() }) });

const branchRef = z.object({ object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) });

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/**
 * GitHub App client. Installation tokens are short-lived (1h), down-scoped to
 * specific repositories and permissions, kept only in process memory, and never
 * persisted, logged, or exposed to the browser, AI service or sandbox.
 */
@Injectable()
export class GithubAppService {
  private readonly tokenCache = new Map<string, CachedToken>();

  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    return this.config.githubApp() !== null;
  }

  /** RS256 App JWT, valid ≤10 minutes as required by GitHub. Backdated 60s for clock skew. */
  appJwt(nowSeconds = Math.floor(Date.now() / 1000)): string {
    const creds = this.config.githubApp();
    if (!creds) throw Errors.notConfigured('GitHub App');
    const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: creds.appId })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(creds.privateKeyPem).toString('base64url');
    return `${unsigned}.${signature}`;
  }

  async getInstallation(installationId: number): Promise<GithubInstallation> {
    return this.call(`/app/installations/${installationId}`, githubInstallation, { auth: `Bearer ${this.appJwt()}` });
  }

  /**
   * Mints (or reuses) an installation token restricted to `repositoryIds` and
   * `permissions`. Reused only while more than 5 minutes of validity remain.
   */
  async installationToken(installationId: number, permissions: GithubPermissions, repositoryIds?: number[]): Promise<string> {
    const key = JSON.stringify([installationId, permissions, repositoryIds ? [...repositoryIds].sort() : null]);
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;
    const res = await this.call(`/app/installations/${installationId}/access_tokens`, installationToken, {
      method: 'POST',
      auth: `Bearer ${this.appJwt()}`,
      body: { permissions, ...(repositoryIds ? { repository_ids: repositoryIds } : {}) },
    });
    this.tokenCache.set(key, { token: res.token, expiresAt: Date.parse(res.expires_at) });
    return res.token;
  }

  /** Drops cached tokens for an installation (on disconnect/suspend). */
  forgetInstallation(installationId: number): void {
    for (const key of this.tokenCache.keys()) {
      if (key.startsWith(`[${installationId},`)) this.tokenCache.delete(key);
    }
  }

  async listInstallationRepositories(installationId: number, page = 1, perPage = 100) {
    const token = await this.installationToken(installationId, { metadata: 'read' });
    return this.call(`/installation/repositories?per_page=${perPage}&page=${page}`, installationRepos, { auth: `token ${token}` });
  }

  async getRepository(installationId: number, repositoryId: number): Promise<GithubRepository> {
    const token = await this.installationToken(installationId, { metadata: 'read' }, [repositoryId]);
    return this.call(`/repositories/${repositoryId}`, githubRepository, { auth: `token ${token}` });
  }

  async resolveBranchSha(installationId: number, repositoryId: number, fullName: string, branch: string): Promise<string> {
    const token = await this.installationToken(installationId, PERMISSION_SETS.read, [repositoryId]);
    const ref = await this.call(`/repos/${encodePath(fullName)}/git/ref/heads/${encodeURIComponent(branch)}`, branchRef, { auth: `token ${token}` });
    return ref.object.sha;
  }

  /** Reads one issue (FR-GIT-006). Issue text is untrusted content. */
  async getIssue(installationId: number, repositoryId: number, fullName: string, issueNumber: number): Promise<GithubIssue> {
    const token = await this.installationToken(installationId, PERMISSION_SETS.readIssue, [repositoryId]);
    return this.call(`/repos/${encodePath(fullName)}/issues/${issueNumber}`, githubIssue, { auth: `token ${token}` });
  }

  /**
   * Reads one pull request, its changed-file list (first page) and, when asked,
   * its first review comments (FR-GIT-006). All of it is untrusted content.
   */
  async getPullRequest(
    installationId: number,
    repositoryId: number,
    fullName: string,
    prNumber: number,
    opts: { includeReviewComments: boolean },
  ): Promise<{ pr: GithubPullRequest; files: GithubPullRequestFile[]; comments: GithubReviewComment[] }> {
    const token = await this.installationToken(installationId, PERMISSION_SETS.readPullRequest, [repositoryId]);
    const auth = `token ${token}`;
    const base = `/repos/${encodePath(fullName)}/pulls/${prNumber}`;
    const pr = await this.call(base, githubPullRequest, { auth });
    const files = await this.call(`${base}/files?per_page=${IMPORT_LIMITS.prFiles}`, z.array(githubPullRequestFile), { auth });
    const comments = opts.includeReviewComments ? await this.call(`${base}/comments?per_page=${IMPORT_LIMITS.reviewComments}`, z.array(githubReviewComment), { auth }) : [];
    return { pr, files: files.slice(0, IMPORT_LIMITS.prFiles), comments: comments.slice(0, IMPORT_LIMITS.reviewComments) };
  }

  /** Reads one check run and its first annotations (FR-WF-001). Output text is untrusted content. */
  async getCheckRun(installationId: number, repositoryId: number, fullName: string, checkRunId: number): Promise<{ check: GithubCheckRun; annotations: GithubCheckAnnotation[] }> {
    const token = await this.installationToken(installationId, PERMISSION_SETS.readChecks, [repositoryId]);
    const auth = `token ${token}`;
    const base = `/repos/${encodePath(fullName)}/check-runs/${checkRunId}`;
    const check = await this.call(base, githubCheckRun, { auth });
    const annotations = check.output.annotations_count > 0 ? await this.call(`${base}/annotations?per_page=${IMPORT_LIMITS.annotations}`, z.array(githubCheckAnnotation), { auth }) : [];
    return { check, annotations: annotations.slice(0, IMPORT_LIMITS.annotations) };
  }

  /** Latest completed check runs for a branch or commit (to pick a failing one). */
  async listCheckRuns(installationId: number, repositoryId: number, fullName: string, ref: string): Promise<GithubCheckRun[]> {
    const token = await this.installationToken(installationId, PERMISSION_SETS.readChecks, [repositoryId]);
    const res = await this.call(`/repos/${encodePath(fullName)}/commits/${ref.split('/').map(encodeURIComponent).join('/')}/check-runs?filter=latest&status=completed&per_page=${IMPORT_LIMITS.checkRuns}`, checkRunList, {
      auth: `token ${token}`,
    });
    return res.check_runs.slice(0, IMPORT_LIMITS.checkRuns);
  }

  // ---------------------------------------------------------------------------
  // Write operations (only after an authorized human PR approval)
  // ---------------------------------------------------------------------------
  async createPullRequest(input: {
    installationId: number;
    repositoryId: number;
    fullName: string;
    baseCommitSha: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
    commitMessage: string;
    changes: Array<{ path: string; content: string | null }>;
  }): Promise<{ number: number; id: number; url: string; headBranch: string; commitSha: string; reused: boolean }> {
    // Re-check what the installation actually grants before any write (SECURITY §6).
    const inst = await this.getInstallation(input.installationId);
    if (inst.permissions.contents !== 'write' || inst.permissions.pull_requests !== 'write') {
      throw new GithubApiError(403, 'installation lacks contents:write and pull_requests:write', false);
    }
    const token = await this.installationToken(input.installationId, PERMISSION_SETS.writePullRequest, [input.repositoryId]);
    const auth = `token ${token}`;
    const repo = `/repos/${encodePath(input.fullName)}`;

    const existingPr = await this.call(`${repo}/pulls?state=all&head=${encodeURIComponent(`${input.fullName.split('/')[0]}:${input.headBranch}`)}`, z.array(pullRequestSchema), { auth });
    if (existingPr[0]) return { number: existingPr[0].number, id: existingPr[0].id, url: existingPr[0].html_url, headBranch: input.headBranch, commitSha: existingPr[0].head.sha, reused: true };

    const baseCommit = await this.call(`${repo}/git/commits/${input.baseCommitSha}`, z.object({ sha: z.string(), tree: z.object({ sha: z.string() }) }), { auth });
    const entries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = [];
    for (const c of input.changes) {
      if (c.content === null) {
        entries.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const blob = await this.call(`${repo}/git/blobs`, z.object({ sha: z.string() }), { method: 'POST', auth, body: { content: c.content, encoding: 'utf-8' } });
      entries.push({ path: c.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const tree = await this.call(`${repo}/git/trees`, z.object({ sha: z.string() }), { method: 'POST', auth, body: { base_tree: baseCommit.tree.sha, tree: entries } });
    const commit = await this.call(`${repo}/git/commits`, z.object({ sha: z.string() }), { method: 'POST', auth, body: { message: input.commitMessage, tree: tree.sha, parents: [baseCommit.sha] } });
    try {
      await this.call(`${repo}/git/refs`, z.object({ ref: z.string() }), { method: 'POST', auth, body: { ref: `refs/heads/${input.headBranch}`, sha: commit.sha } });
    } catch (err) {
      if (!(err instanceof GithubApiError) || err.status !== 422) throw err;
      // Branch exists (e.g. a retried request): only reuse it if it points at a commit we would create.
      const ref = await this.call(`${repo}/git/ref/heads/${encodeURIComponent(input.headBranch)}`, branchRef, { auth });
      const head = await this.call(`${repo}/git/commits/${ref.object.sha}`, z.object({ tree: z.object({ sha: z.string() }) }), { auth });
      if (head.tree.sha !== tree.sha) throw new GithubApiError(409, 'head branch already exists with different content', false);
    }
    const pr = await this.call(`${repo}/pulls`, pullRequestSchema, { method: 'POST', auth, body: { title: input.title, head: input.headBranch, base: input.baseBranch, body: input.body, maintainer_can_modify: false } });
    return { number: pr.number, id: pr.id, url: pr.html_url, headBranch: input.headBranch, commitSha: commit.sha, reused: false };
  }

  /** Streams the repository tarball at an exact commit. */
  async downloadTarball(installationId: number, repositoryId: number, fullName: string, sha: string, maxBytes: number): Promise<Buffer> {
    const token = await this.installationToken(installationId, PERMISSION_SETS.read, [repositoryId]);
    const res = await this.raw(`/repos/${encodePath(fullName)}/tarball/${sha}`, { auth: `token ${token}`, redirect: 'follow', timeoutMs: 120_000 });
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new GithubApiError(413, 'repository archive exceeds the configured size limit', false);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new GithubApiError(413, 'repository archive exceeds the configured size limit', false);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** Installation ids visible to a user (verifies a user may link an installation). */
  async userInstallationIds(userToken: string): Promise<Set<number>> {
    const ids = new Set<number>();
    for (let page = 1; page <= 10; page++) {
      const res = await this.call(`/user/installations?per_page=100&page=${page}`, userInstallations, { auth: `Bearer ${userToken}` });
      res.installations.forEach((i) => ids.add(i.id));
      if (res.installations.length < 100) break;
    }
    return ids;
  }

  /** Exchanges an OAuth code (from the install flow) for a user token. Not persisted. */
  async exchangeUserCode(code: string): Promise<string> {
    const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_WEB_URL } = this.config.env;
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) throw Errors.notConfigured('GitHub App OAuth');
    let res: Response;
    try {
      res = await fetch(new URL('/login/oauth/access_token', GITHUB_WEB_URL), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch {
      throw Errors.upstream('GITHUB_UNAVAILABLE', 'GitHub could not be reached.');
    }
    const body = z.object({ access_token: z.string().min(1) }).safeParse(await res.json().catch(() => null));
    if (!res.ok || !body.success) throw Errors.forbidden('GitHub authorization could not be verified.');
    return body.data.access_token;
  }

  // ---------------------------------------------------------------------------
  private async call<T extends ZodType>(
    path: string,
    schema: T,
    opts: { method?: string; auth: string; body?: unknown },
  ): Promise<z.infer<T>> {
    const res = await this.raw(path, opts);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      log.warn({ path: redactPath(path) }, 'unexpected GitHub response shape');
      throw new GithubApiError(502, 'unexpected response from GitHub', true);
    }
    return parsed.data;
  }

  private async raw(path: string, opts: { method?: string; auth: string; body?: unknown; redirect?: 'follow' | 'error' | 'manual'; timeoutMs?: number }): Promise<Response> {
    const url = new URL(path.replace(/^\//, ''), this.config.env.GITHUB_API_URL.replace(/\/?$/, '/'));
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'anvaya',
          Authorization: opts.auth,
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        // API calls never follow redirects (avoids leaking the Authorization header);
        // tarball downloads follow GitHub's redirect to its codeload host.
        redirect: opts.redirect ?? 'error',
      });
    } catch (err) {
      log.warn({ path: redactPath(path), err: (err as Error).message }, 'github request failed');
      throw new GithubApiError(503, 'GitHub could not be reached', true);
    }
    if (!res.ok) {
      const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
      const transient = rateLimited || res.status >= 500;
      log.warn({ path: redactPath(path), status: res.status }, 'github request rejected');
      throw new GithubApiError(res.status, rateLimited ? 'GitHub rate limit reached' : `GitHub responded with ${res.status}`, transient);
    }
    return res;
  }
}

function encodePath(fullName: string): string {
  const [owner, name] = fullName.split('/');
  if (!owner || !name) throw Errors.badRequest('invalid repository name');
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function redactPath(path: string): string {
  return path.split('?')[0] ?? path;
}

/** Maps a GitHub client error to an API error for request/response paths. */
export function toAppError(err: unknown): Error {
  if (err instanceof GithubApiError) {
    if (err.status === 404 || err.status === 403) return Errors.forbidden('The GitHub App installation does not grant access to this resource.');
    if (err.status === 401) return Errors.upstream('GITHUB_AUTH_FAILED', 'GitHub rejected the App credentials.');
    if (err.status === 429 || err.message.includes('rate limit')) return Errors.unavailable('GITHUB_RATE_LIMITED', 'GitHub rate limit reached; try again later.');
    return Errors.upstream('GITHUB_ERROR', 'GitHub request failed.');
  }
  return err as Error;
}
