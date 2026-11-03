/**
 * Hand-written response schemas for work package B (templates, call graph, impact and test
 * selection, workspace search/Q&A) and the fields it adds to existing responses. Enforced
 * against live responses by test/response-contract.ts like every other route.
 */
import { z, type ZodType } from 'zod';
import { HOSTED_PROVIDERS } from '../ai/ai-policy.service.js';
import { TEMPLATE_WORKFLOWS } from '../templates/templates.js';

const iso = z.iso.datetime();
const budget = z.object({
  max_steps: z.number().optional(),
  max_input_tokens: z.number().optional(),
  max_output_tokens: z.number().optional(),
  max_duration_seconds: z.number().optional(),
  max_changed_files: z.number().optional(),
  max_repair_attempts: z.number().optional(),
});
const taskDefaults = z.object({ title_prefix: z.string().nullable(), description_template: z.string().nullable(), labels: z.array(z.string()) });

export const templateView = z.object({
  key: z.string(),
  id: z.uuid().nullable(),
  source: z.enum(['builtin', 'workspace']),
  name: z.string(),
  description: z.string(),
  workflow: z.enum(TEMPLATE_WORKFLOWS),
  plan_only: z.boolean(),
  task_defaults: taskDefaults,
  budget,
  allowed_profiles: z.array(z.string()).nullable(),
  planning_guidance: z.array(z.string()),
  version: z.number(),
  status: z.enum(['active', 'archived']),
  created_at: iso.nullable(),
  updated_at: iso.nullable(),
});

/** Immutable template snapshot stored on a task. */
export const templateSnapshot = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  workflow: z.enum(TEMPLATE_WORKFLOWS),
  task_defaults: taskDefaults,
  budget,
  allowed_profiles: z.array(z.string()).nullable(),
  planning_guidance: z.array(z.string()),
  source: z.enum(['builtin', 'workspace']),
  template_id: z.string().nullable(),
  version: z.number(),
});
const runTemplate = z.object({ key: z.string(), name: z.string(), workflow: z.enum(TEMPLATE_WORKFLOWS), source: z.enum(['builtin', 'workspace']), version: z.number() });

const symbolInfo = z.object({ id: z.uuid(), name: z.string(), qualified_name: z.string().nullable(), kind: z.string(), path: z.string(), start_line: z.number(), end_line: z.number() });

export const callGraphView = z.object({
  snapshot_id: z.uuid(),
  commit_sha: z.string(),
  root: symbolInfo,
  direction: z.enum(['callers', 'callees', 'both']),
  depth: z.number(),
  nodes: z.array(z.object({ symbol: symbolInfo, depth: z.number(), direction: z.enum(['caller', 'callee']) })),
  edges: z.array(z.object({ source_id: z.uuid(), target_id: z.uuid(), type: z.string(), line: z.number().nullable(), path: z.string() })),
  unresolved_callees: z.array(z.object({ name: z.string(), type: z.string(), line: z.number().nullable() })),
  total_nodes: z.number(),
  next_cursor: z.string().nullable(),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
});

const evidenceStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('imports'), from: z.string(), to: z.string(), line: z.number().nullable() }),
  z.object({ kind: z.literal('calls'), from: z.string(), to: z.string(), line: z.number().nullable(), caller: z.string(), callee: z.string() }),
  z.object({ kind: z.literal('changed'), path: z.string() }),
  z.object({ kind: z.literal('naming'), from: z.string(), to: z.string() }),
]);

const impactCore = {
  heuristic: z.literal(true),
  disclaimer: z.string(),
  changed_files: z.array(z.object({ path: z.string(), indexed: z.boolean(), symbols: z.number() })),
  changed_symbols: z.array(symbolInfo),
  impacted_files: z.array(z.object({ path: z.string(), distance: z.number(), reason: z.enum(['imports', 'calls']), evidence: z.array(evidenceStep) })),
  impacted_symbols: z.array(z.object({ symbol: symbolInfo, depth: z.number(), evidence: z.array(evidenceStep) })),
  selected_tests: z.array(
    z.object({
      path: z.string(),
      score: z.number(),
      reasons: z.array(z.object({ kind: z.enum(['changed', 'imports', 'calls', 'naming']), description: z.string(), evidence: z.array(evidenceStep) })),
    }),
  ),
  test_files_total: z.number(),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
};

export const impactView = z.object({ snapshot_id: z.uuid(), commit_sha: z.string(), source: z.literal('request'), ...impactCore });

export const runImpactView = z.object({
  run_id: z.uuid(),
  source: z.enum(['patch', 'plan', 'none']),
  patch_id: z.uuid().nullable(),
  plan_version: z.number().nullable(),
  snapshot_id: z.uuid().nullable(),
  commit_sha: z.string().nullable(),
  applied_selections: z.array(z.object({ profile_id: z.string(), attempt: z.number(), selection: z.record(z.string(), z.unknown()) })),
  ...impactCore,
});

const workspaceResult = z.object({
  source: z.enum(['code', 'knowledge']),
  repository_id: z.uuid(),
  repository_full_name: z.string(),
  commit_sha: z.string().nullable(),
  path: z.string().nullable(),
  start_line: z.number(),
  end_line: z.number(),
  content_hash: z.string(),
  symbol: z.string().nullable(),
  language: z.string().nullable(),
  knowledge_document_id: z.uuid().nullable(),
  title: z.string().nullable(),
  snippet: z.string(),
  score: z.number(),
});
const repoSummary = z.object({ id: z.uuid(), full_name: z.string(), commit_sha: z.string(), results: z.number(), semantic: z.string() });
const skipped = z.object({ id: z.uuid(), full_name: z.string(), reason: z.string() });

export const workspaceSearchView = z.object({
  query: z.string(),
  results: z.array(workspaceResult),
  repositories: z.array(repoSummary),
  skipped_repositories: z.array(skipped),
  retrieval: z.object({ mode: z.enum(['hybrid', 'lexical']), repositories_searched: z.number(), duration_ms: z.number() }),
  limitations: z.array(z.string()),
});

export const workspaceAnswerView = z.object({
  answer: z.string(),
  insufficient_evidence: z.boolean(),
  citations: z.array(workspaceResult.extend({ evidence_id: z.string(), supports: z.string() })),
  limitations: z.array(z.string()),
  repositories: z.array(repoSummary),
  skipped_repositories: z.array(skipped),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  mode: z.enum(['local', 'cloud', 'mock']),
  prompt_version: z.string().nullable(),
  data_disclosure: z.object({ provider: z.string().nullable(), data_categories: z.array(z.string()) }).nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), duration_ms: z.number(), schema_repair_attempted: z.boolean() }).nullable(),
});

const migrationSection = z.object({
  affected_areas: z.array(z.object({ area: z.string(), description: z.string(), files: z.array(z.string()), evidence_ids: z.array(z.string()) })),
  prerequisites: z.array(z.string()),
  step_rollback: z.array(z.object({ step_id: z.string(), rollback: z.string() })),
  rollback_strategy: z.array(z.string()),
});
const evidenceRef = z.object({ id: z.string(), path: z.string(), start_line: z.number(), end_line: z.number(), commit_sha: z.string(), content_hash: z.string().optional(), symbol: z.string().nullable() });

type Obj = z.ZodObject;
const extendObject = (s: ZodType | undefined, shape: Record<string, ZodType>): ZodType | undefined => (s instanceof z.ZodObject ? (s as Obj).extend(shape) : s);
const extendItems = (s: ZodType | undefined, shape: Record<string, ZodType>): ZodType | undefined => (s instanceof z.ZodArray && s.element instanceof z.ZodObject ? z.array((s.element as Obj).extend(shape)) : s);

/** Adds package-B fields to the sample-derived schemas of existing routes. */
export function extendExistingResponses(responses: Record<string, ZodType>): Record<string, ZodType> {
  const out = { ...responses };
  const taskFields = { template_key: z.string().nullable(), template: templateSnapshot.nullable() };
  for (const k of ['get /tasks/{taskId}', 'post /repositories/{repositoryId}/tasks']) out[k] = extendObject(out[k], taskFields)!;
  out['get /tasks'] = extendItems(out['get /tasks'], taskFields)!;
  out['get /runs/{runId}'] = extendObject(out['get /runs/{runId}'], { template: runTemplate.nullable(), plan_only: z.boolean() })!;
  const plan = out['get /runs/{runId}/plan'];
  if (plan instanceof z.ZodObject) {
    const shape = (plan as Obj).shape as Record<string, ZodType>;
    const inner = shape.plan instanceof z.ZodObject ? (shape.plan as Obj).extend({ migration: migrationSection.optional() }) : shape.plan!;
    out['get /runs/{runId}/plan'] = (plan as Obj).extend({ plan: inner, migration_evidence: z.array(evidenceRef), plan_only: z.boolean() });
  }
  const ver = out['get /runs/{runId}/verification'];
  if (ver instanceof z.ZodObject) {
    const shape = (ver as Obj).shape as Record<string, ZodType>;
    out['get /runs/{runId}/verification'] = (ver as Obj).extend({ results: extendItems(shape.results, { test_selection: z.record(z.string(), z.unknown()).nullable() })! });
  }
  const providerEnum = z.enum(HOSTED_PROVIDERS).nullable();
  for (const k of ['get /workspaces/{workspaceId}/ai-policy', 'patch /workspaces/{workspaceId}/ai-policy']) {
    const s = out[k];
    if (s instanceof z.ZodObject) {
      const cloud = ((s as Obj).shape as Record<string, ZodType>).cloud;
      if (cloud instanceof z.ZodObject) out[k] = (s as Obj).extend({ cloud: (cloud as Obj).extend({ provider: providerEnum }) });
    }
  }
  return out;
}
