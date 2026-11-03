/**
 * Precision pass over the sample-derived response schemas (I-8): replaces
 * strings with the real enums from the domain types and fills in shapes the
 * samples could not show. Every rule is checked against live responses by
 * test/response-contract.ts, so a wrong rule fails the suite.
 */
import { z, type ZodType } from 'zod';
import { RUN_ACTIVE_STATUSES, RUN_TERMINAL_STATUSES } from '../database/types.js';
import { SYMBOL_KINDS } from '../indexing/code-intel.controller.js';
import { taskSourceContextSchema } from '../runs/run.schemas.js';

const ROLE = z.enum(['owner', 'admin', 'member', 'viewer']);
const RUN_STATUS = z.enum([...RUN_ACTIVE_STATUSES, ...RUN_TERMINAL_STATUSES]);
const RUN_MODE = z.enum(['local', 'cloud', 'mock']);
const TASK_STATUS = z.enum(['open', 'active', 'completed', 'failed', 'cancelled', 'archived']);
const TASK_SOURCE = z.enum(['github_issue', 'pull_request', 'failing_check', 'manual']);
const KNOWLEDGE_SOURCE = z.enum(['readme', 'architecture', 'decision', 'issue', 'pull_request', 'engineering_note']);
const REPO_STATUS = z.enum(['connected', 'disabled', 'disconnected']);
const INDEXING_STATUS = z.enum(['pending', 'queued', 'indexing', 'ready', 'partial', 'failed', 'disabled']);
const SNAPSHOT_STATUS = z.enum(['queued', 'processing', 'ready', 'partial', 'failed']);
const JOB_STATUS = z.enum(['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled']);
const PARSE_STATUS = z.enum(['parsed', 'unsupported_language', 'parse_error', 'not_parsed', 'excluded']);
const SEVERITY = z.enum(['info', 'low', 'medium', 'high', 'critical']);
const FINDING_STATUS = z.enum(['open', 'accepted', 'dismissed', 'fixed']);
const STEP_STATUS = z.enum(['queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']);
const VERIFICATION_STATUS = z.enum(['passed', 'failed', 'timed_out', 'skipped', 'error']);
const PATCH_STATUS = z.enum(['proposed', 'validated', 'applied', 'rejected']);
const APPROVAL_TYPE = z.enum(['plan', 'pull_request', 'other']);
const DECISION = z.enum(['approved', 'rejected']);
const SYMBOL_KIND = z.enum(SYMBOL_KINDS);
const RELATIONSHIP = z.enum(['calls', 'extends', 'instantiates', 'imports']);
const CITATION_SOURCE = z.enum(['code', 'knowledge']);
const SEMANTIC = z.enum(['ok', 'unavailable', 'disabled']);
const LEXICAL = z.enum(['ok', 'disabled']);

const iso = z.iso.datetime();
const jobView = z.object({
  id: z.uuid(),
  status: JOB_STATUS,
  stage: z.string().nullable(),
  trigger: z.string(),
  commit_sha: z.string().nullable(),
  progress: z.record(z.string(), z.unknown()),
  attempts: z.number(),
  error_code: z.string().nullable(),
  error_summary: z.string().nullable(),
  created_at: iso,
  started_at: iso.nullable(),
  ended_at: iso.nullable(),
});
const artifacts = z.object({
  patches: z.array(
    z.object({
      id: z.uuid(),
      type: z.literal('patch'),
      patch_hash: z.string(),
      base_commit_sha: z.string(),
      changed_files: z.unknown(),
      additions: z.number(),
      deletions: z.number(),
      status: PATCH_STATUS,
      created_at: iso,
    }),
  ),
  verification_logs: z.array(
    z.object({
      id: z.uuid(),
      type: z.literal('verification'),
      profile_id: z.string(),
      status: VERIFICATION_STATUS,
      exit_code: z.number().nullable(),
      duration_ms: z.number().nullable(),
      created_at: iso,
    }),
  ),
});

const planApproval = z.object({ decision: DECISION, user_id: z.uuid(), comment: z.string().nullable(), subject_hash: z.string(), created_at: iso });

type Rule = [route: RegExp, path: string, schema: ZodType];

const RUN_ROUTES = /^(get \/runs|get \/runs\/\{runId\}|get \/tasks\/\{taskId\}\/runs|post \/tasks\/\{taskId\}\/runs|post \/runs\/\{runId\}\/(cancel|retry|plan-approval|pr-approval))$/;
const REPO_ROUTES = /^(get \/repositories|get \/repositories\/\{repositoryId\}|patch \/repositories\/\{repositoryId\}|post \/repositories)$/;
const TASK_ROUTES = /^(get \/tasks|get \/tasks\/\{taskId\}|patch \/tasks\/\{taskId\}|post \/repositories\/\{repositoryId\}\/tasks)$/;
const QA_ROUTES = /questions/;
const SYMBOL_ROUTES = /symbols/;
const ANY = /./;

// Workspace, member and invitation routes use hand-written schemas (workspaces.schemas.ts) with real enums.
/** [route pattern, path ("[]" = array item, "?" = any one key level), enum]. Paths are matched from the `data` root. */
const RULES: Rule[] = [
  [ANY, 'memberships[].role', ROLE],
  [RUN_ROUTES, 'status', RUN_STATUS],
  [RUN_ROUTES, '[].status', RUN_STATUS],
  [RUN_ROUTES, 'mode', RUN_MODE],
  [RUN_ROUTES, '[].mode', RUN_MODE],
  [RUN_ROUTES, 'approvals[].approval_type', APPROVAL_TYPE],
  [RUN_ROUTES, 'approvals[].decision', DECISION],
  [TASK_ROUTES, 'status', TASK_STATUS],
  [TASK_ROUTES, '[].status', TASK_STATUS],
  [TASK_ROUTES, 'source_type', TASK_SOURCE],
  [TASK_ROUTES, '[].source_type', TASK_SOURCE],
  [TASK_ROUTES, 'source_context', taskSourceContextSchema],
  [TASK_ROUTES, '[].source_context', taskSourceContextSchema],
  [TASK_ROUTES, 'latest_run.status', RUN_STATUS],
  [TASK_ROUTES, '[].latest_run.status', RUN_STATUS],
  [REPO_ROUTES, 'status', REPO_STATUS],
  [REPO_ROUTES, '[].status', REPO_STATUS],
  [REPO_ROUTES, 'indexing_status', INDEXING_STATUS],
  [REPO_ROUTES, '[].indexing_status', INDEXING_STATUS],
  [/index-status/, 'indexing_status', INDEXING_STATUS],
  [/index-status/, 'latest_snapshot.status', SNAPSHOT_STATUS],
  [/index-status/, 'last_job.status', JOB_STATUS],
  [/index-status/, 'active_job', jobView.nullable()],
  [/index-status/, 'last_job', jobView.nullable()],
  [/^post \/repositories\/\{repositoryId\}\/index$/, 'status', JOB_STATUS],
  [/snapshots/, '[].status', SNAPSHOT_STATUS],
  [/knowledge/, 'source_type', KNOWLEDGE_SOURCE],
  [/knowledge/, '[].source_type', KNOWLEDGE_SOURCE],
  [QA_ROUTES, 'mode', RUN_MODE],
  [QA_ROUTES, '[].mode', RUN_MODE],
  [QA_ROUTES, 'citations[].source', CITATION_SOURCE],
  [QA_ROUTES, '[].citations[].source', CITATION_SOURCE],
  [/questions|search/, 'retrieval.semantic', SEMANTIC],
  [/questions|search/, 'retrieval.lexical', LEXICAL],
  [/search/, 'retrieval.snapshot_status', SNAPSHOT_STATUS],
  [QA_ROUTES, 'retrieval.snapshot_status', SNAPSHOT_STATUS],
  [SYMBOL_ROUTES, '[].kind', SYMBOL_KIND],
  [SYMBOL_ROUTES, 'symbol.kind', SYMBOL_KIND],
  [SYMBOL_ROUTES, 'incoming[].source.kind', SYMBOL_KIND],
  [SYMBOL_ROUTES, 'outgoing[].target.kind', SYMBOL_KIND],
  [SYMBOL_ROUTES, 'incoming[].type', RELATIONSHIP],
  [SYMBOL_ROUTES, 'outgoing[].type', RELATIONSHIP],
  [/tree/, 'entries[].type', z.enum(['directory', 'file'])],
  [/tree/, 'entries[].parse_status', PARSE_STATUS],
  [/files\/content/, 'parse_status', PARSE_STATUS],
  [/review$/, 'ai_findings[].severity', SEVERITY],
  [/review$/, 'deterministic_findings[].severity', SEVERITY],
  [/review$/, 'ai_findings[].status', FINDING_STATUS],
  [/review$/, 'deterministic_findings[].status', FINDING_STATUS],
  [/disposition/, 'status', FINDING_STATUS],
  [/steps/, '[].status', STEP_STATUS],
  [/verification$/, 'results[].status', VERIFICATION_STATUS],
  // Skipped results (e.g. dependencies refused) have not run, so these are null.
  [/verification$/, 'results[].exit_code', z.number().nullable()],
  [/verification$/, 'results[].duration_ms', z.number().nullable()],
  [/verification$/, 'results[].stdout_excerpt', z.string().nullable()],
  [/verification$/, 'results[].stderr_excerpt', z.string().nullable()],
  [/diff$/, 'attempts[].status', PATCH_STATUS],
  [/ai-policy/, 'default_mode', RUN_MODE],
  [/health-check/, 'mode', RUN_MODE],
  [/artifacts/, '', artifacts],
  [/^get \/runs\/\{runId\}\/plan$/, 'approval', planApproval.nullable()],
  [/audit-events/, '[].actor_type', z.enum(['user', 'system', 'worker', 'provider'])],
  [/integrations\/github\/(installations|complete)/, 'status', z.enum(['active', 'suspended', 'disconnected'])],
  [/integrations\/github\/(installations|complete)/, '[].status', z.enum(['active', 'suspended', 'disconnected'])],
  [REPO_ROUTES, 'visibility', z.enum(['public', 'private', 'internal'])],
  [REPO_ROUTES, '[].visibility', z.enum(['public', 'private', 'internal'])],
  [/\/plan$/, 'source', z.enum(['agent', 'user_edit'])],
  [/review$/, 'ai_findings[].source', z.enum(['ai_review', 'static_analysis', 'security_scanner', 'test'])],
  [/review$/, 'deterministic_findings[].source', z.enum(['ai_review', 'static_analysis', 'security_scanner', 'test'])],
  [/verification$/, 'unavailable[].kind', z.enum(['unsupported', 'sandbox_error'])],
];

function unwrap(s: ZodType): { inner: ZodType; wrap: (x: ZodType) => ZodType } {
  if (s instanceof z.ZodOptional) {
    const u = unwrap(s.unwrap() as ZodType);
    return { inner: u.inner, wrap: (x) => u.wrap(x).optional() };
  }
  if (s instanceof z.ZodNullable) {
    const u = unwrap(s.unwrap() as ZodType);
    return { inner: u.inner, wrap: (x) => u.wrap(x).nullable() };
  }
  return { inner: s, wrap: (x) => x };
}

/** Replaces the schema at `path` (keeping optional/nullable wrappers); unknown paths are reported. */
export function replaceAt(schema: ZodType, path: string[], replacement: ZodType): ZodType {
  const { inner, wrap } = unwrap(schema);
  if (path.length === 0) {
    // Keep the original's nullability when the replacement does not set its own.
    return replacement instanceof z.ZodNullable || replacement instanceof z.ZodOptional ? replacement : wrap(replacement);
  }
  const [head, ...rest] = path;
  if (head === '[]') {
    if (!(inner instanceof z.ZodArray)) throw new Error('expected array');
    return wrap(z.array(replaceAt(inner.element as ZodType, rest, replacement)));
  }
  if (!(inner instanceof z.ZodObject)) throw new Error(`expected object at ${head}`);
  const field = (inner.shape as Record<string, ZodType | undefined>)[head!];
  if (!field) throw new Error(`no field ${head}`);
  return wrap(inner.extend({ [head!]: replaceAt(field, rest, replacement) }));
}

const splitPath = (p: string): string[] => (p === '' ? [] : p.replace(/\[\]/g, '.[]').split('.').filter(Boolean));

const applied = new Set<number>();

/** Rules that matched no route shape (a typo or a stale path); asserted empty in tests. */
export function unusedRules(): string[] {
  return RULES.flatMap(([route, path], i) => (applied.has(i) ? [] : [`${String(route)} ${path}`]));
}

/** Applies every matching rule to the derived schema for `routeKey`. */
export function refine(routeKey: string, schema: ZodType | undefined): ZodType | undefined {
  if (!schema) return schema;
  let out = schema;
  for (const [i, [route, path, replacement]] of RULES.entries()) {
    if (!route.test(routeKey)) continue;
    try {
      out = replaceAt(out, splitPath(path), replacement);
      applied.add(i);
    } catch {
      // The rule's path does not exist in this route's shape; rules are shared across routes.
    }
  }
  return out;
}
