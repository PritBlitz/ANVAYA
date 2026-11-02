import { z, type ZodType } from 'zod';
import { ROUTES, type RouteDoc, SCHEMA_COMPONENTS } from './registry.js';

type Json = Record<string, unknown>;

function schema(t: ZodType): Json {
  const s = z.toJSONSchema(t, { io: 'input', unrepresentable: 'any', target: 'openapi-3.0' }) as Json;
  delete s.$schema;
  return s;
}

function queryParams(t: ZodType): Json[] {
  const s = schema(t);
  const props = (s.properties ?? {}) as Record<string, Json>;
  const required = new Set((s.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, p]) => ({ name, in: 'query', required: required.has(name) && p.default === undefined, schema: p }));
}

const ERROR_CODES: Record<number, string> = {
  400: 'Malformed request',
  401: 'Unauthenticated',
  403: 'Forbidden (insufficient role) or CSRF_TOKEN_INVALID',
  404: 'Not found, or concealed because the caller is not a member of the owning workspace',
  409: 'State or idempotency conflict',
  422: 'Validation failed',
  429: 'Rate or budget limit',
};

function operation(r: RouteDoc): Json {
  const params: Json[] = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }));
  if (r.query) params.push(...queryParams(r.query));
  if (r.idempotency) params.push({ name: 'Idempotency-Key', in: 'header', required: r.idempotency === 'required', schema: { type: 'string', minLength: 8, maxLength: 255, pattern: '^[A-Za-z0-9._:-]+$' } });
  if (!r.public && r.method !== 'get') params.push({ name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' }, description: 'Value of the anvaya_csrf cookie' });
  if (r.workspaceHeader) params.push({ name: 'X-Workspace-Id', in: 'header', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Alternative to workspace_id; if both are sent they must match (400 WORKSPACE_MISMATCH)' });
  params.push({ name: 'X-Request-Id', in: 'header', required: false, schema: { type: 'string' } });
  if (r.sse) params.push({ name: 'Last-Event-ID', in: 'header', required: false, schema: { type: 'string' } });

  const dataSchema = r.response ? schema(r.response) : { type: r.paginated ? 'array' : 'object', ...(r.paginated ? { items: { type: 'object' } } : {}) };
  const success: Json =
    r.status === 204 || r.status === 302
      ? { description: r.status === 204 ? 'No content' : 'Redirect' }
      : r.sse
        ? { description: 'text/event-stream of run events', content: { 'text/event-stream': { schema: { type: 'string' } } } }
        : {
            description: 'Success',
            content: { 'application/json': { schema: { type: 'object', required: ['data', 'meta'], properties: { data: dataSchema, meta: { $ref: r.paginated ? '#/components/schemas/PageMeta' : '#/components/schemas/Meta' } } } } },
          };
  const responses: Json = { [String(r.status)]: success };
  for (const [code, description] of Object.entries(ERROR_CODES)) {
    if (r.public && code === '401') continue;
    responses[code] = { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } };
  }
  return {
    tags: [r.tag],
    summary: r.summary,
    ...(r.description ? { description: r.description } : {}),
    operationId: `${r.method}_${r.path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    ...(r.public ? { security: [] } : {}),
    parameters: params,
    ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(r.body) } } } } : {}),
    responses,
  };
}

export function buildOpenApi(version = '0.1.0'): Json {
  const paths: Record<string, Json> = {};
  for (const r of ROUTES) (paths[r.path] ??= {})[r.method] = operation(r);
  return {
    openapi: '3.0.3',
    info: {
      title: 'Anvaya API',
      version,
      description:
        'Generated from the runtime Zod schemas (apps/api/src/openapi). Base path /api/v1. Cookie sessions + session-bound CSRF header on mutations. See docs/backend/API_CONTRACT_NOTES.md for behavioural details.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ sessionCookie: [] }],
    tags: [...new Set(ROUTES.map((r) => r.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'anvaya_session' } },
      schemas: {
        Meta: { type: 'object', required: ['request_id'], properties: { request_id: { type: 'string' } } },
        PageMeta: {
          type: 'object',
          required: ['request_id', 'page'],
          properties: { request_id: { type: 'string' }, page: { type: 'object', properties: { next_cursor: { type: 'string', nullable: true }, has_more: { type: 'boolean' } } } },
        },
        ErrorEnvelope: {
          type: 'object',
          required: ['error', 'meta'],
          properties: {
            error: { type: 'object', required: ['code', 'message', 'details'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' } } },
            meta: { $ref: '#/components/schemas/Meta' },
          },
        },
        ...Object.fromEntries(Object.entries(SCHEMA_COMPONENTS).map(([k, v]) => [k, schema(v)])),
      },
    },
  };
}
