/**
 * Test-only response contract enforcement (I-8). Loaded as a vitest setup file.
 *
 * Every JSON success envelope the API sends during the suite is checked
 * against the response schema documented for its route in
 * `src/openapi/registry.ts`. A mismatch turns the response into a 500
 * `RESPONSE_SCHEMA_MISMATCH`, so the test that made the request fails and the
 * published OpenAPI document cannot drift from what the server returns.
 *
 * With ANVAYA_CAPTURE_RESPONSES=<file>, responses are also appended to that
 * file as JSON lines (used to (re)derive schemas for new routes).
 */
import { appendFileSync } from 'node:fs';
import express from 'express';
import type { ZodType } from 'zod';
import { ROUTES } from '../src/openapi/registry.js';

type Res = express.Response & { req: express.Request };

const byKey = new Map<string, { schema?: ZodType; paginated: boolean }>();
for (const r of ROUTES) byKey.set(`${r.method} ${r.path}`, { schema: r.response, paginated: Boolean(r.paginated) });

const capture = process.env.ANVAYA_CAPTURE_RESPONSES;
const proto = express.response as unknown as { json: (this: Res, body: unknown) => Res; __anvayaContract?: boolean };

if (!proto.__anvayaContract) {
  proto.__anvayaContract = true;
  const original = proto.json;
  proto.json = function json(this: Res, body: unknown) {
    const route = (this.req.route as { path?: string } | undefined)?.path;
    const status = this.statusCode;
    if (route && status >= 200 && status < 300 && body && typeof body === 'object' && 'data' in body) {
      const key = `${this.req.method.toLowerCase()} ${route.replace(/^\/api\/v1/, '').replace(/:(\w+)/g, '{$1}')}`;
      const doc = byKey.get(key);
      const data: unknown = body.data;
      if (capture) appendFileSync(capture, `${JSON.stringify({ key, status, data })}\n`);
      if (doc?.schema) {
        const parsed = doc.schema.safeParse(data);
        if (!parsed.success) {
          const issues = parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }));
          process.stderr.write(`RESPONSE_SCHEMA_MISMATCH ${key} ${JSON.stringify(issues)}\n`);
          this.status(500);
          return original.call(this, { error: { code: 'RESPONSE_SCHEMA_MISMATCH', message: `Response for ${key} does not match its documented schema.`, details: { issues } }, meta: {} });
        }
      }
    }
    return original.call(this, body);
  };
}
