import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfig } from '../config/config.js';
import { AiClient, AiServiceError, isTimeoutError } from './ai-client.js';

const DIM = 768;

/** AI service stand-in that withholds response headers for `x-test-delay` ms, like a slow local model. */
let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const delay = Number(req.headers['x-test-delay'] ?? 0);
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ provider: 'mock', model: 'm', model_version: '1', dimension: DIM, embeddings: [new Array(DIM).fill(0)], usage: {}, duration_ms: delay }));
      }, delay);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function client(timeoutMs: number) {
  const config = new AppConfig({ DATABASE_URL: 'postgres://x', AI_SERVICE_TOKEN: 'x'.repeat(20), AI_SERVICE_URL: baseUrl, AI_REQUEST_TIMEOUT_MS: String(timeoutMs), EMBEDDING_DIMENSION: String(DIM) });
  return new AiClient(config);
}

describe('AI client timeouts', () => {
  it('classifies undici idle-timer failures as timeouts, not as an unavailable service', () => {
    const headersTimeout = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    expect(isTimeoutError(headersTimeout)).toBe(true);
    expect(isTimeoutError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    expect(isTimeoutError(refused)).toBe(false);
  });

  it('waits for a slow response that is still inside the deadline', async () => {
    const c = client(10_000);
    const res = await withDelay(1500, () => c.embed(['a'], 'query'));
    expect(res.embeddings).toHaveLength(1);
  });

  it('reports AI_TIMEOUT (504, retryable) when the deadline passes first', async () => {
    const c = client(1_000);
    const err = await withDelay(3000, () => c.embed(['a'], 'query')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiServiceError);
    expect(err).toMatchObject({ code: 'AI_TIMEOUT', status: 504, retryable: true });
  });
});

/** Runs `fn` with every request to the stand-in server delayed by `ms`. */
async function withDelay<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const listener = (req: { headers: Record<string, unknown> }) => {
    req.headers['x-test-delay'] = String(ms);
  };
  server.prependListener('request', listener);
  try {
    return await fn();
  } finally {
    server.off('request', listener);
  }
}
