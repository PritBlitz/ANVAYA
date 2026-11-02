#!/usr/bin/env node
/**
 * Derives Zod response schemas (I-8) from real responses captured during the
 * test suite:
 *
 *   ANVAYA_CAPTURE_RESPONSES=/tmp/responses.jsonl npx vitest run
 *   node scripts/derive-response-schemas.mjs /tmp/responses.jsonl > src/openapi/responses.generated.ts
 *
 * The generated file is a starting point that is committed and reviewed; the
 * test-time contract check (test/response-contract.ts) keeps it honest.
 * Inference rules: a field missing from some samples is optional, a field seen
 * as null is nullable, UUID and ISO timestamps get formats, and objects under
 * known map-like keys become records.
 */
import { readFileSync } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Objects whose keys are data, not field names. */
const MAP_KEYS = new Set([
  'excluded_by_reason',
  'parse_status',
  'languages',
  'language_stats',
  'progress',
  'metadata',
  'metadata_redacted',
  'granted_permissions',
  'permissions',
  'details',
  'by_operation',
  'by_provider',
  'by_model',
  'settings',
  'budgets',
  'validation',
  'context',
  'input',
  'output',
  'evidence',
]);

const S = 'z.string().nullable()';
const T = 'z.iso.datetime().nullable()';
const U = 'z.uuid().nullable()';
/** Types for fields that were null (or empty arrays) in every captured sample. */
const KNOWN_TYPES = {
  error_summary: S, error_code: S, retry_of_run_id: U, current_stage: S, cancel_requested_at: T, source_url: S,
  provider: S, model: S, ended_at: T, display_name: S, avatar_url: S, started_at: T, latest_indexed_commit_sha: S,
  indexed_at: T, disposition_comment: S, disposition_by: U, disposition_at: T, user_agent: S, title: S,
  suggested_action: S, semantic_reason: S, knowledge_document_id: U, external_number: 'z.number().nullable()',
  detail: S, created_by: U, connected_repository_id: U, confidence: "z.enum(['low', 'medium', 'high']).nullable()",
  data_disclosure: 'z.object({ provider: z.string().nullable(), data_categories: z.array(z.string()) }).nullable()',
  limitations: 'z.array(z.string()).nullable()', approval: 'z.record(z.string(), z.unknown()).nullable()',
  active_job: 'z.record(z.string(), z.unknown()).nullable()', comment: S, expires_at: T, accepted_at: T, revoked_at: T,
};
const STRING_ARRAYS = new Set(['unknowns', 'hypotheses', 'labels', 'data_categories', 'limitations', 'evidence_included']);

function empty() {
  return { seen: 0, nul: 0, bool: 0, num: 0, str: 0, strUuid: 0, strIso: 0, arr: null, arrN: 0, obj: null, objN: 0, record: false };
}

function add(node, v, keyName) {
  node.seen++;
  if (v === null || v === undefined) return void node.nul++;
  if (typeof v === 'boolean') return void node.bool++;
  if (typeof v === 'number') return void node.num++;
  if (typeof v === 'string') {
    node.str++;
    if (UUID.test(v)) node.strUuid++;
    if (ISO.test(v)) node.strIso++;
    return;
  }
  if (Array.isArray(v)) {
    node.arrN++;
    node.arr ??= empty();
    for (const x of v) add(node.arr, x);
    return;
  }
  node.objN++;
  if (MAP_KEYS.has(keyName)) {
    node.record = true;
    node.obj ??= { __values: empty() };
    for (const x of Object.values(v)) add(node.obj.__values, x);
    return;
  }
  node.obj ??= { __count: 0, props: new Map() };
  node.obj.__count = (node.obj.__count ?? 0) + 1;
  for (const [k, x] of Object.entries(v)) {
    if (!node.obj.props.has(k)) node.obj.props.set(k, { node: empty(), present: 0 });
    const p = node.obj.props.get(k);
    p.present++;
    add(p.node, x, k);
  }
}

function emit(node, indent, keyName) {
  const onlyNull = node.nul === node.seen;
  if (onlyNull && keyName && KNOWN_TYPES[keyName]) return KNOWN_TYPES[keyName];
  if (keyName && STRING_ARRAYS.has(keyName) && node.arrN && !node.arr.seen && !node.obj && !node.str) return `z.array(z.string())${node.nul ? '.nullable()' : ''}`;
  const kinds = [];
  if (node.bool) kinds.push('z.boolean()');
  if (node.num) kinds.push('z.number()');
  if (node.str) kinds.push(node.strUuid === node.str ? 'z.uuid()' : node.strIso === node.str ? 'z.iso.datetime()' : 'z.string()');
  if (node.arrN) kinds.push(`z.array(${node.arr.seen ? emit(node.arr, indent) : 'z.unknown()'})`);
  if (node.objN) {
    if (node.record) {
      kinds.push(`z.record(z.string(), ${node.obj.__values.seen ? emit(node.obj.__values, indent) : 'z.unknown()'})`);
    } else {
      const pad = '  '.repeat(indent + 1);
      const props = [...node.obj.props.entries()].map(([k, p]) => {
        const optional = p.present < node.obj.__count;
        const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
        return `${pad}${key}: ${emit(p.node, indent + 1, k)}${optional ? '.optional()' : ''},`;
      });
      kinds.push(props.length ? `z.object({\n${props.join('\n')}\n${'  '.repeat(indent)}})` : 'z.object({})');
    }
  }
  let out;
  if (kinds.length === 0) out = 'z.unknown()';
  else if (kinds.length === 1) out = kinds[0];
  else out = `z.union([${kinds.join(', ')}])`;
  if (node.nul && kinds.length > 0) out += '.nullable()';
  return out;
}

const file = process.argv[2];
if (!file) {
  console.error('usage: derive-response-schemas.mjs <responses.jsonl>');
  process.exit(2);
}
const roots = new Map();
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const { key, data } = JSON.parse(line);
  if (!roots.has(key)) roots.set(key, empty());
  add(roots.get(key), data);
}

const keys = [...roots.keys()].sort();
let out = `// Generated by scripts/derive-response-schemas.mjs from responses captured in the test suite,
// then reviewed. Checked against live responses by test/response-contract.ts.
import { z, type ZodType } from 'zod';

export const RESPONSES: Record<string, ZodType> = {
`;
for (const k of keys) out += `  ${JSON.stringify(k)}: ${emit(roots.get(k), 1)},\n`;
out += '};\n';
process.stdout.write(out);
