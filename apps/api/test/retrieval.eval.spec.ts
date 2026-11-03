import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAi } from './fake-ai.js';
import { FakeGithub } from './fake-github.js';
import { as, bootApp, createWorkspace, login, type TestUser } from './helpers.js';
import { externalId, linkInstallation, runIndexing } from './scenario.js';
import { buildTarball } from './tarball.js';

/**
 * Retrieval benchmark (ROADMAP Phase 7; methodology in docs/evaluations/retrieval.md).
 *
 * Corpus: this API's own non-test TypeScript sources, indexed through the real pipeline (tarball →
 * Tree-sitter chunks → embeddings → Postgres). Each labelled question names the file(s) that answer
 * it; a question counts as found at k when any relevant file appears in the top k results.
 *
 *   default             mock embeddings (deterministic, CI): lexical is meaningful; semantic is noise
 *                       by construction, so only lexical/hybrid thresholds are enforced.
 *   EVAL_EMBEDDINGS=live real embeddings: EVAL_AI_SERVICE_URL / EVAL_AI_SERVICE_TOKEN point at a
 *                       running AI service with EMBEDDING_PROVIDER=ollama (nomic-embed-text). Separate
 *                       names are needed because vitest.config.ts pins AI_SERVICE_URL/TOKEN for tests.
 *   EVAL_OUT=<file>     also write the results as JSON.
 */

const QUESTIONS: Array<{ q: string; relevant: string[] }> = [
  { q: 'How are GitHub webhook signatures verified?', relevant: ['src/github/webhooks.controller.ts'] },
  { q: 'Where is the CSRF token checked on state-changing requests?', relevant: ['src/identity/auth.guard.ts'] },
  { q: 'Which configuration settings are refused when running in production?', relevant: ['src/config/config.ts'] },
  { q: 'Which run status transitions are legal?', relevant: ['src/runs/state-machine.ts'] },
  { q: 'Where does a model call get its timeout and token budget?', relevant: ['src/runs/stage-toolkit.ts'] },
  { q: 'How does the gVisor sandbox build its OCI runtime spec?', relevant: ['src/execution/gvisor-sandbox.ts'] },
  { q: 'Which verification profiles exist and how are they chosen for a repository?', relevant: ['src/execution/profiles.ts'] },
  { q: 'How is a model-generated patch validated before it is applied?', relevant: ['src/execution/patch-validator.ts'] },
  { q: 'Where are secrets and tokens redacted from text?', relevant: ['src/common/redact.ts'] },
  { q: 'How are idempotency keys stored and requests replayed?', relevant: ['src/common/idempotency.ts'] },
  { q: 'How are requests rate limited and Retry-After returned?', relevant: ['src/common/rate-limit.ts', 'src/common/http.ts'] },
  { q: 'How is source code split into chunks for search?', relevant: ['src/indexing/chunker.ts'] },
  { q: 'Which files are skipped during indexing, such as binaries, vendored code and secrets?', relevant: ['src/indexing/classifier.ts'] },
  { q: 'How are import statements resolved to files for the dependency map?', relevant: ['src/indexing/import-resolver.ts'] },
  { q: 'How are lexical and vector search results combined?', relevant: ['src/retrieval/retrieval.service.ts'] },
  { q: 'How are expired sessions and old snapshots purged?', relevant: ['src/worker/retention.service.ts'] },
  { q: 'How is the workspace chosen from the X-Workspace-Id header or workspace_id?', relevant: ['src/common/workspace-scope.ts'] },
  { q: 'How are workspace membership and roles checked before accessing a repository?', relevant: ['src/workspaces/access.service.ts'] },
  { q: 'How does the API call the AI service and map its errors?', relevant: ['src/ai/ai-client.ts'] },
  { q: 'How are pull requests and failing checks imported as task context?', relevant: ['src/runs/task-sources.ts'] },
  { q: 'How are database migrations applied and protected by checksums?', relevant: ['src/database/migrator.ts'] },
  { q: 'Where is a sign-in session created and the session cookie set?', relevant: ['src/identity/session.service.ts'] },
  { q: 'How is keyset cursor pagination encoded?', relevant: ['src/database/keyset.ts'] },
  { q: 'After plan approval, how is the patch applied, verified and repaired?', relevant: ['src/execution/execution-pipeline.ts'] },
  { q: 'How does repository Q&A refuse to answer without supporting evidence?', relevant: ['src/ai/questions.service.ts'] },
];

const MODES = ['lexical', 'semantic', 'hybrid'] as const;
const live = process.env.EVAL_EMBEDDINGS === 'live';
// CPU-only nomic-embed-text indexes the corpus in roughly 15-30 minutes; mock embeddings take seconds.
const TIMEOUT_MS = live ? 3_600_000 : 600_000;

function liveAiEnv(): Record<string, string> {
  const url = process.env.EVAL_AI_SERVICE_URL;
  const token = process.env.EVAL_AI_SERVICE_TOKEN;
  if (!url || !token) throw new Error('EVAL_EMBEDDINGS=live needs EVAL_AI_SERVICE_URL and EVAL_AI_SERVICE_TOKEN');
  return { AI_SERVICE_URL: url, AI_SERVICE_TOKEN: token };
}

function corpus(): Array<{ name: string; content: string }> {
  const root = path.resolve(__dirname, '..');
  const out: Array<{ name: string; content: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (abs.endsWith('.ts') && !abs.endsWith('.spec.ts') && !abs.endsWith('responses.generated.ts')) {
        out.push({ name: path.relative(root, abs).replace(/\\/g, '/'), content: readFileSync(abs, 'utf8') });
      }
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

describe('retrieval benchmark', () => {
  const gh = new FakeGithub();
  const ai = new FakeAi();
  let app: INestApplication;
  let owner: TestUser;
  let repoUuid: string;
  const files = corpus();

  beforeAll(async () => {
    await gh.start();
    if (!live) await ai.start();
    Object.assign(process.env, gh.env(), live ? liveAiEnv() : { AI_SERVICE_URL: ai.url });
    app = await bootApp();
    owner = await login(app);
    const ws = await createWorkspace(owner);
    const link = await linkInstallation(gh, owner, ws);
    const sha = 'e'.repeat(40);
    const ext = externalId();
    gh.addRepo(
      { id: ext, owner: 'acme', name: 'anvaya-api', default_branch: 'main', private: true, branches: { main: sha }, tarballs: { [sha]: await buildTarball('acme-anvaya-api-eval', files) } },
      link.installationId,
    );
    const res = await as(owner, 'post', '/repositories').send({ workspace_id: ws, installation_id: link.installationUuid, external_repository_id: ext }).expect(201);
    repoUuid = res.body.data.id;
    await runIndexing(app, repoUuid);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
    await gh.stop();
    if (!live) await ai.stop();
  });

  it('scores lexical, semantic and hybrid retrieval on labelled questions', async () => {
    const status = await as(owner, 'get', `/repositories/${repoUuid}/index-status`).expect(200);
    expect(['ready', 'partial']).toContain(status.body.data.indexing_status);

    const results: Record<string, { recall_at_5: number; recall_at_10: number; mrr: number; misses_at_10: string[] }> = {};
    for (const mode of MODES) {
      let at5 = 0;
      let at10 = 0;
      let rr = 0;
      const misses: string[] = [];
      for (const { q, relevant } of QUESTIONS) {
        const res = await as(owner, 'post', `/repositories/${repoUuid}/search`).send({ query: q, mode, top_k: 10 }).expect(200);
        const paths = [...new Set((res.body.data.results as Array<{ file_path: string }>).map((r) => r.file_path))];
        const rank = paths.findIndex((p) => relevant.includes(p));
        if (rank >= 0 && rank < 5) at5++;
        if (rank >= 0 && rank < 10) at10++;
        else misses.push(q);
        rr += rank >= 0 ? 1 / (rank + 1) : 0;
      }
      const n = QUESTIONS.length;
      results[mode] = { recall_at_5: at5 / n, recall_at_10: at10 / n, mrr: Number((rr / n).toFixed(3)), misses_at_10: misses };
    }

    const report = { embeddings: live ? 'live' : 'mock', corpus_files: files.length, questions: QUESTIONS.length, results };
    process.stdout.write(`retrieval benchmark: ${JSON.stringify(report, null, 2)}
`);
    if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, JSON.stringify(report, null, 2) + '\n');

    // Regression floors (set from the first measured baseline, with margin).
    expect(results.lexical!.recall_at_10).toBeGreaterThanOrEqual(0.6);
    expect(results.hybrid!.recall_at_10).toBeGreaterThanOrEqual(0.6);
    if (live) expect(results.semantic!.recall_at_10).toBeGreaterThanOrEqual(0.5);
  }, TIMEOUT_MS);
});
