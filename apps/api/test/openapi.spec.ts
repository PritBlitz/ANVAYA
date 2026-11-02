import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApi } from '../src/openapi/generate.js';
import { unusedRules } from '../src/openapi/refinements.js';
import { ROUTES } from '../src/openapi/registry.js';
import { bootApp } from './helpers.js';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

describe('OpenAPI contract', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('documents exactly the routes the server exposes', () => {
    const express = app.getHttpAdapter().getInstance() as { router: { stack: Layer[] } };
    const live = new Set<string>();
    for (const layer of express.router.stack) {
      if (!layer.route || layer.route.path === '/') continue;
      for (const m of Object.keys(layer.route.methods)) {
        if (!['get', 'post', 'patch', 'delete'].includes(m)) continue;
        live.add(`${m} ${layer.route.path.replace(/^\/api\/v1/, '').replace(/:(\w+)/g, '{$1}')}`);
      }
    }
    const documented = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    expect([...live].filter((r) => !documented.has(r)).sort()).toEqual([]);
    expect([...documented].filter((r) => !live.has(r)).sort()).toEqual([]);
  });

  it('applies every response refinement rule to at least one route', () => {
    expect(unusedRules()).toEqual([]);
  });

  it('generates a valid-looking OpenAPI 3 document with request schemas', () => {
    const doc = buildOpenApi() as { openapi: string; paths: Record<string, Record<string, { requestBody?: unknown; parameters: Array<{ name: string; required: boolean }> }>> };
    expect(doc.openapi).toBe('3.0.3');
    const createWs = doc.paths['/workspaces']!.post!;
    expect(createWs.requestBody).toBeTruthy();
    const pr = doc.paths['/runs/{runId}/pull-request']!.post!;
    expect(pr.parameters.find((p) => p.name === 'Idempotency-Key')!.required).toBe(true);
    expect(pr.parameters.find((p) => p.name === 'X-CSRF-Token')!.required).toBe(true);
  });

  it('the committed openapi.json is up to date (run `npm run openapi`)', () => {
    const committed = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as unknown;
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });
});
