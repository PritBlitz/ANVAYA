import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';

export const FAKE_EMBED_DIM = 768;

/** Deterministic bag-of-words embedding: similar vocabulary → similar vectors. */
export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(FAKE_EMBED_DIM).fill(0);
  const terms = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  for (const t of terms) {
    const h = createHash('sha1').update(t).digest();
    v[h.readUInt16BE(0) % FAKE_EMBED_DIM]! += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export type GenerateHandler = (body: Record<string, unknown>) => { status?: number; body: unknown };

/**
 * Minimal fake of the internal AI service contract for API-side tests. The
 * real FastAPI service is tested separately (services/ai-service/tests).
 */
export class FakeAi {
  available = true;
  model = 'fake-embed';
  modelVersion = '1';
  readonly token = 'test-internal-token-0123456789';
  embedCalls = 0;
  generateCalls: Array<Record<string, unknown>> = [];
  generateHandler?: GenerateHandler;
  private server?: Server;
  url = '';

  async start(): Promise<void> {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req: Request, res: Response, next) => {
      if (req.header('authorization') !== `Bearer ${this.token}`) return void res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'bad token' } });
      if (!this.available) return void res.status(503).json({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'embedding provider unavailable' } });
      next();
    });
    app.post('/internal/v1/embeddings', (req, res) => {
      this.embedCalls++;
      const texts = (req.body as { texts: string[] }).texts;
      res.json({ provider: 'fake', model: this.model, model_version: this.modelVersion, dimension: FAKE_EMBED_DIM, embeddings: texts.map(fakeEmbedding), usage: { input_tokens: 0 }, duration_ms: 1 });
    });
    app.post('/internal/v1/generate', (req, res) => {
      const body = req.body as Record<string, unknown>;
      this.generateCalls.push(body);
      if (!this.generateHandler) return void res.status(500).json({ error: { code: 'NO_HANDLER', message: 'no handler' } });
      const out = this.generateHandler(body);
      res.status(out.status ?? 200).json(out.body);
    });
    app.post('/internal/v1/providers/health', (req, res) => {
      const body = req.body as { mode: string };
      res.json({ provider: body.mode === 'mock' ? 'mock' : 'ollama', mode: body.mode, available: true, models: ['fake'], detail: null });
    });
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve());
    });
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
