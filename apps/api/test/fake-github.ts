import { createHash, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Request, type Response } from 'express';

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  default_branch: string;
  private: boolean;
  /** branch → sha */
  branches: Record<string, string>;
  /** sha → gzipped tarball */
  tarballs?: Record<string, Buffer>;
  issues?: Record<number, { title: string; body: string; labels?: string[]; pull_request?: boolean }>;
}

export interface FakeInstallation {
  id: number;
  account: string;
  repos: number[];
  permissions?: Record<string, string>;
}

export interface TokenGrant {
  installationId: number;
  permissions: Record<string, string>;
  repositoryIds: number[] | null;
}

/**
 * In-process fake of the GitHub REST API surface Anvaya uses. App JWTs are
 * cryptographically verified against the generated key pair so tests exercise
 * real signing. Every installation-token grant is recorded for least-privilege
 * assertions.
 */
export class FakeGithub {
  readonly appId = '424242';
  readonly privateKeyPem: string;
  private readonly publicKeyPem: string;
  readonly installations = new Map<number, FakeInstallation>();
  readonly repos = new Map<number, FakeRepo>();
  /** OAuth code → installation ids visible to that user. */
  readonly oauthCodes = new Map<string, number[]>();
  private readonly userTokens = new Map<string, number[]>();
  private readonly installationTokens = new Map<string, TokenGrant>();
  readonly grants: TokenGrant[] = [];
  readonly pulls: Array<{ repoId: number; number: number; id: number; title: string; head: string; base: string; body: string; commitSha: string; files: Record<string, string | null> }> = [];
  private readonly gitObjects = new Map<string, { type: 'blob' | 'tree' | 'commit'; data: unknown }>();
  private readonly refs = new Map<string, string>();
  /** When set, write calls fail with this status (simulates GitHub outages). */
  failWrites: number | null = null;
  private server?: Server;
  url = '';

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  env(): Record<string, string> {
    return {
      GITHUB_API_URL: this.url,
      GITHUB_WEB_URL: this.url,
      GITHUB_APP_ID: this.appId,
      GITHUB_APP_SLUG: 'anvaya-test',
      GITHUB_APP_PRIVATE_KEY: this.privateKeyPem.replace(/\n/g, '\\n'),
      GITHUB_CLIENT_ID: 'Iv1.testclient',
      GITHUB_CLIENT_SECRET: 'test-client-secret',
    };
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    app.post('/login/oauth/access_token', (req: Request, res: Response) => {
      const body = req.body as { code?: string; client_secret?: string };
      const visible = body.code ? this.oauthCodes.get(body.code) : undefined;
      if (!visible || body.client_secret !== 'test-client-secret') return void res.json({ error: 'bad_verification_code' });
      const token = `gho_${randomBytes(18).toString('hex')}`;
      this.userTokens.set(token, visible);
      res.json({ access_token: token, token_type: 'bearer' });
    });

    app.get('/user/installations', (req, res) => {
      const ids = this.userTokens.get(bearer(req) ?? '');
      if (!ids) return void res.status(401).json({ message: 'Bad credentials' });
      res.json({ total_count: ids.length, installations: ids.map((id) => ({ id })) });
    });

    app.get('/app/installations/:id', (req, res) => {
      if (!this.verifyJwt(bearer(req))) return void res.status(401).json({ message: 'bad jwt' });
      const inst = this.installations.get(Number(req.params.id));
      if (!inst) return void res.status(404).json({ message: 'Not Found' });
      res.json({ id: inst.id, account: { login: inst.account, id: 1, type: 'Organization' }, permissions: inst.permissions ?? { contents: 'write', metadata: 'read', pull_requests: 'write' }, suspended_at: null });
    });

    app.post('/app/installations/:id/access_tokens', (req, res) => {
      if (!this.verifyJwt(bearer(req))) return void res.status(401).json({ message: 'bad jwt' });
      const inst = this.installations.get(Number(req.params.id));
      if (!inst) return void res.status(404).json({ message: 'Not Found' });
      const body = req.body as { permissions?: Record<string, string>; repository_ids?: number[] };
      if (body.repository_ids?.some((r) => !inst.repos.includes(r))) return void res.status(422).json({ message: 'repository not accessible' });
      const grant: TokenGrant = { installationId: inst.id, permissions: body.permissions ?? {}, repositoryIds: body.repository_ids ?? null };
      this.grants.push(grant);
      const token = `ghs_${randomBytes(18).toString('hex')}`;
      this.installationTokens.set(token, grant);
      res.status(201).json({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    });

    app.get('/installation/repositories', (req, res) => {
      const grant = this.installationTokens.get(tokenAuth(req) ?? '');
      if (!grant) return void res.status(401).json({ message: 'Bad credentials' });
      const inst = this.installations.get(grant.installationId)!;
      const repos = inst.repos.map((id) => this.repoJson(this.repos.get(id)!));
      res.json({ total_count: repos.length, repositories: repos });
    });

    app.get('/repositories/:id', (req, res) => {
      const grant = this.installationTokens.get(tokenAuth(req) ?? '');
      const id = Number(req.params.id);
      if (!grant) return void res.status(401).json({ message: 'Bad credentials' });
      if (!this.grantCovers(grant, id)) return void res.status(404).json({ message: 'Not Found' });
      res.json(this.repoJson(this.repos.get(id)!));
    });

    app.get('/repos/:owner/:name/git/ref/heads/:branch', (req, res) => {
      const repo = this.findRepo(req.params.owner, req.params.name);
      const grant = this.installationTokens.get(tokenAuth(req) ?? '');
      if (!repo || !grant || !this.grantCovers(grant, repo.id)) return void res.status(404).json({ message: 'Not Found' });
      const sha = repo.branches[req.params.branch];
      if (!sha) return void res.status(404).json({ message: 'Not Found' });
      res.json({ ref: `refs/heads/${req.params.branch}`, object: { sha, type: 'commit' } });
    });

    app.get('/repos/:owner/:name/issues/:num', (req, res) => {
      const repo = this.findRepo(req.params.owner, req.params.name);
      const grant = this.installationTokens.get(tokenAuth(req) ?? '');
      if (!repo || !grant || !this.grantCovers(grant, repo.id) || grant.permissions.issues !== 'read') return void res.status(404).json({ message: 'Not Found' });
      const n = Number(req.params.num);
      const issue = repo.issues?.[n];
      if (!issue) return void res.status(404).json({ message: 'Not Found' });
      res.json({ number: n, title: issue.title, body: issue.body, state: 'open', html_url: `https://github.test/${repo.owner}/${repo.name}/issues/${n}`, labels: (issue.labels ?? []).map((name) => ({ name })), ...(issue.pull_request ? { pull_request: {} } : {}) });
    });

    const writeGrant = (req: Request, repo: FakeRepo | undefined, perm: 'contents' | 'pull_requests') => {
      const grant = this.installationTokens.get(tokenAuth(req) ?? '');
      if (!repo || !grant || !this.grantCovers(grant, repo.id)) return null;
      return grant.permissions[perm] === 'write' ? grant : null;
    };
    const oid = (seed: unknown) => createHash('sha1').update(JSON.stringify(seed) + randomBytes(4).toString('hex')).digest('hex');

    app.get('/repos/:owner/:name/git/commits/:sha', (req, res) => {
      const repo = this.findRepo(req.params.owner, req.params.name);
      if (!repo || !this.installationTokens.get(tokenAuth(req) ?? '')) return void res.status(404).json({ message: 'Not Found' });
      const obj = this.gitObjects.get(req.params.sha);
      if (obj?.type === 'commit') return void res.json({ sha: req.params.sha, tree: { sha: (obj.data as { tree: string }).tree } });
      res.json({ sha: req.params.sha, tree: { sha: `tree-of-${req.params.sha}` } });
    });
    app.post('/repos/:owner/:name/git/blobs', (req, res) => {
      if (this.failWrites) return void res.status(this.failWrites).json({ message: 'unavailable' });
      const repo = this.findRepo(req.params.owner, req.params.name);
      if (!writeGrant(req, repo, 'contents')) return void res.status(404).json({ message: 'Not Found' });
      const sha = oid(req.body);
      this.gitObjects.set(sha, { type: 'blob', data: (req.body as { content: string }).content });
      res.status(201).json({ sha });
    });
    app.post('/repos/:owner/:name/git/trees', (req, res) => {
      const repo = this.findRepo(req.params.owner, req.params.name);
      if (!writeGrant(req, repo, 'contents')) return void res.status(404).json({ message: 'Not Found' });
      const body = req.body as { tree: Array<{ path: string; sha: string | null }> };
      const files = Object.fromEntries(body.tree.map((t) => [t.path, t.sha ? (this.gitObjects.get(t.sha)?.data as string) : null]));
      const sha = createHash('sha1').update(JSON.stringify(files)).digest('hex');
      this.gitObjects.set(sha, { type: 'tree', data: files });
      res.status(201).json({ sha });
    });
    app.post('/repos/:owner/:name/git/commits', (req, res) => {
      const repo = this.findRepo(req.params.owner, req.params.name);
      if (!writeGrant(req, repo, 'contents')) return void res.status(404).json({ message: 'Not Found' });
      const sha = oid(req.body);
      this.gitObjects.set(sha, { type: 'commit', data: req.body });
      res.status(201).json({ sha });
    });
    app.post('/repos/:owner/:name/git/refs', (req, res) => {
      const repo = this.findRepo(req.params.owner, req.params.name);
      if (!writeGrant(req, repo, 'contents')) return void res.status(404).json({ message: 'Not Found' });
      const body = req.body as { ref: string; sha: string };
      const key = `${repo!.id}:${body.ref}`;
      if (this.refs.has(key)) return void res.status(422).json({ message: 'Reference already exists' });
      this.refs.set(key, body.sha);
      res.status(201).json({ ref: body.ref, object: { sha: body.sha } });
    });
    app.get('/repos/:owner/:name/pulls', (req, res) => {
      const repo = this.findRepo(req.params.owner, req.params.name);
      if (!repo || !this.installationTokens.get(tokenAuth(req) ?? '')) return void res.status(404).json({ message: 'Not Found' });
      const head = (typeof req.query.head === 'string' ? req.query.head : '').split(':')[1];
      res.json(this.pulls.filter((p) => p.repoId === repo.id && p.head === head).map((p) => ({ id: p.id, number: p.number, html_url: `https://github.test/pr/${p.number}`, head: { sha: p.commitSha, ref: p.head } })));
    });
    app.post('/repos/:owner/:name/pulls', (req, res) => {
      const repo = this.findRepo(req.params.owner, req.params.name);
      if (!writeGrant(req, repo, 'pull_requests')) return void res.status(404).json({ message: 'Not Found' });
      const body = req.body as { title: string; head: string; base: string; body: string };
      const commitSha = this.refs.get(`${repo!.id}:refs/heads/${body.head}`);
      if (!commitSha) return void res.status(422).json({ message: 'head not found' });
      const commit = this.gitObjects.get(commitSha)!.data as { tree: string };
      const files = this.gitObjects.get(commit.tree)!.data as Record<string, string | null>;
      const pr = { repoId: repo!.id, number: this.pulls.length + 1, id: 5000 + this.pulls.length, title: body.title, head: body.head, base: body.base, body: body.body, commitSha, files };
      this.pulls.push(pr);
      res.status(201).json({ id: pr.id, number: pr.number, html_url: `https://github.test/pr/${pr.number}`, head: { sha: commitSha, ref: body.head } });
    });

    app.get('/repos/:owner/:name/tarball/:sha', (req, res) => {
      const repo = this.findRepo(req.params.owner, req.params.name);
      const grant = this.installationTokens.get(tokenAuth(req) ?? '');
      if (!repo || !grant || !this.grantCovers(grant, repo.id) || grant.permissions.contents !== 'read') return void res.status(404).json({ message: 'Not Found' });
      const tar = repo.tarballs?.[req.params.sha];
      if (!tar) return void res.status(404).json({ message: 'Not Found' });
      res.setHeader('Content-Type', 'application/x-gzip');
      res.setHeader('Content-Length', String(tar.length));
      res.end(tar);
    });

    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve());
    });
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  addRepo(repo: FakeRepo, installationId: number): void {
    this.repos.set(repo.id, repo);
    this.installations.get(installationId)?.repos.push(repo.id);
  }

  private grantCovers(grant: TokenGrant, repoId: number): boolean {
    const inst = this.installations.get(grant.installationId);
    if (!inst?.repos.includes(repoId)) return false;
    return grant.repositoryIds === null || grant.repositoryIds.includes(repoId);
  }

  private findRepo(owner: string, name: string): FakeRepo | undefined {
    return [...this.repos.values()].find((r) => r.owner === owner && r.name === name);
  }

  private repoJson(r: FakeRepo) {
    return {
      id: r.id,
      name: r.name,
      full_name: `${r.owner}/${r.name}`,
      owner: { login: r.owner, id: 1, type: 'Organization' },
      private: r.private,
      visibility: r.private ? 'private' : 'public',
      default_branch: r.default_branch,
      archived: false,
    };
  }

  private verifyJwt(token: string | undefined): boolean {
    if (!token) return false;
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return false;
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(this.publicKeyPem, Buffer.from(s, 'base64url'));
    if (!ok) return false;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as { iss: string; exp: number; iat: number };
    const now = Math.floor(Date.now() / 1000);
    return payload.iss === this.appId && payload.exp > now && payload.exp - payload.iat <= 600;
  }
}

function bearer(req: Request): string | undefined {
  const h = req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

function tokenAuth(req: Request): string | undefined {
  const h = req.header('authorization');
  return h?.startsWith('token ') ? h.slice(6) : undefined;
}
