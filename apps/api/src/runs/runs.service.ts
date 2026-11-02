import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AiPolicyService } from '../ai/ai-policy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { decodeCursor, type Page, toPage, zodIssues } from '../common/http.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { beforeCursor, cursorUs } from '../database/keyset.js';
import { json, type WorkflowRun } from '../database/types.js';
import { QueueService } from '../queue/queues.js';
import { AccessService } from '../workspaces/access.service.js';
import { runBudgetLimitsSchema } from '../workspaces/workspaces.schemas.js';
import { RunEventsService } from './run-events.service.js';
import { DEFAULT_RUN_BUDGET, editPlanBody, type listRunsQuery, planApprovalBody, planHash, planSchema, type RunBudget, startRunBody } from './run.schemas.js';
import { RunTransitionsService } from './run-transitions.service.js';
import { HUMAN_STATES, isTerminal, WORKER_STATES } from './state-machine.js';

export function runView(r: WorkflowRun) {
  return {
    id: r.id,
    task_id: r.task_id,
    workspace_id: r.organization_id,
    repository_id: r.repository_id,
    run_number: r.run_number,
    status: r.status,
    current_stage: r.current_stage,
    mode: r.mode,
    provider: r.provider,
    model: r.model,
    base_branch: r.base_branch,
    snapshot_id: r.snapshot_id,
    state_version: r.state_version,
    budget: r.budget,
    usage_summary: r.usage_summary,
    retry_of_run_id: r.retry_of_run_id,
    error_code: r.error_code,
    error_summary: r.error_summary,
    cancel_requested_at: r.cancel_requested_at?.toISOString() ?? null,
    started_at: r.started_at?.toISOString() ?? null,
    ended_at: r.ended_at?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

interface EvidenceRef {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  commit_sha: string;
  content_hash?: string;
  symbol?: string | null;
}

/**
 * GAP-21: resolve each investigation finding's `evidence_ids` into file:line
 * references, using only the run's server-side retrieval records (the same set
 * as `retrieval.completed`). Model output never supplies a location, and
 * unknown ids are dropped.
 */
export function withResolvedEvidence(investigation: unknown, evidence: unknown): unknown {
  if (!investigation || typeof investigation !== 'object' || Array.isArray(investigation)) return investigation ?? null;
  const inv = investigation as { findings?: unknown };
  if (!Array.isArray(inv.findings)) return investigation;
  const refs = new Map<string, EvidenceRef>();
  for (const e of Array.isArray(evidence) ? evidence : []) {
    const r = e as Partial<EvidenceRef>;
    if (typeof r.id === 'string' && typeof r.path === 'string' && typeof r.start_line === 'number' && typeof r.end_line === 'number' && typeof r.commit_sha === 'string') {
      refs.set(r.id, { id: r.id, path: r.path, start_line: r.start_line, end_line: r.end_line, commit_sha: r.commit_sha, content_hash: r.content_hash, symbol: r.symbol ?? null });
    }
  }
  return {
    ...inv,
    findings: (inv.findings as unknown[]).map((f: unknown): unknown => {
      if (!f || typeof f !== 'object') return f;
      const ids = (f as { evidence_ids?: unknown }).evidence_ids;
      const resolved = Array.isArray(ids) ? (ids as unknown[]).flatMap((id) => (typeof id === 'string' && refs.has(id) ? [refs.get(id)!] : [])) : [];
      return { ...(f as Record<string, unknown>), evidence: resolved };
    }),
  };
}

/** Clamp: a client can never raise its own maximums above workspace policy (API_SPEC §5). */
export function clampBudget(requested: Partial<RunBudget> | undefined, ceilings: Partial<RunBudget>, aiLimits: { max_input_tokens: number; max_output_tokens: number }): RunBudget {
  const ceiling: RunBudget = {
    ...DEFAULT_RUN_BUDGET,
    ...ceilings,
    max_input_tokens: Math.min(ceilings.max_input_tokens ?? DEFAULT_RUN_BUDGET.max_input_tokens, aiLimits.max_input_tokens),
    max_output_tokens: Math.min(ceilings.max_output_tokens ?? DEFAULT_RUN_BUDGET.max_output_tokens, aiLimits.max_output_tokens),
  };
  const out = { ...ceiling };
  for (const k of Object.keys(ceiling) as Array<keyof RunBudget>) {
    const r = requested?.[k];
    if (r !== undefined) out[k] = Math.min(r, ceiling[k]);
  }
  return out;
}

@Injectable()
export class RunsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly transitions: RunTransitionsService,
    private readonly events: RunEventsService,
    private readonly queues: QueueService,
    private readonly aiPolicy: AiPolicyService,
  ) {}

  async start(userId: string, taskId: string, body: z.infer<typeof startRunBody>) {
    const { task } = await this.access.requireTask(userId, taskId, 'member');
    if (task.status === 'archived') throw Errors.invalidState('Archived tasks cannot be run.');
    const repo = await this.database.db.selectFrom('repositories').selectAll().where('id', '=', task.repository_id).executeTakeFirstOrThrow();
    if (repo.status !== 'connected') throw Errors.invalidState('The repository is not connected.');
    if (!repo.latest_indexed_commit_sha) throw Errors.conflict('REPOSITORY_NOT_INDEXED', 'Index the repository before starting a run.');
    const snapshot = await this.database.db
      .selectFrom('repository_snapshots')
      .select('id')
      .where('repository_id', '=', repo.id)
      .where('commit_sha', '=', repo.latest_indexed_commit_sha)
      .executeTakeFirstOrThrow();
    const org = await this.database.db.selectFrom('organizations').select('settings').where('id', '=', task.organization_id).executeTakeFirstOrThrow();
    const policy = await this.aiPolicy.load(task.organization_id);
    const resolved = this.aiPolicy.resolve(policy, body.mode);
    const limits = runBudgetLimitsSchema.safeParse(org.settings.run_budget_limits);
    const budget = clampBudget(body.budgets, limits.success ? limits.data : {}, policy.limits);

    const run = await this.database.transaction(async (tx) => {
      await tx.selectFrom('engineering_tasks').select('id').where('id', '=', taskId).forUpdate().executeTakeFirstOrThrow();
      const active = await tx
        .selectFrom('workflow_runs')
        .select('id')
        .where('task_id', '=', taskId)
        .where('status', 'not in', ['completed', 'failed', 'cancelled', 'timed_out', 'rejected', 'completed_without_pr'])
        .executeTakeFirst();
      if (active) throw Errors.conflict('RUN_ALREADY_ACTIVE', 'This task already has an active run.', { run_id: active.id });
      const next = await tx.selectFrom('workflow_runs').select(sql<number>`coalesce(max(run_number), 0) + 1`.as('n')).where('task_id', '=', taskId).executeTakeFirstOrThrow();
      const created = await tx
        .insertInto('workflow_runs')
        .values({
          organization_id: task.organization_id,
          task_id: taskId,
          run_number: Number(next.n),
          status: 'queued',
          mode: resolved.mode,
          provider: resolved.provider,
          model: resolved.model,
          budget: json(budget),
          usage_summary: json({ input_tokens: 0, output_tokens: 0, model_calls: 0, agent_steps: 0 }),
          repository_id: repo.id,
          snapshot_id: snapshot.id,
          base_branch: body.base_branch ?? repo.default_branch,
          created_by: userId,
          checkpoint: json({ commit_sha: repo.latest_indexed_commit_sha, data_disclosure: resolved.disclosure }),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx.insertInto('run_state_transitions').values({ run_id: created.id, from_status: null, to_status: 'queued', state_version: 1, actor_type: 'user', actor_user_id: userId, reason: 'run started' }).execute();
      await this.events.emit(tx, created, 'run.created', { status: 'queued', run_number: created.run_number, mode: created.mode, budget });
      await tx.updateTable('engineering_tasks').set({ status: 'active' }).where('id', '=', taskId).execute();
      await this.audit.record({ organizationId: task.organization_id, actorUserId: userId, action: 'run.started', resourceType: 'run', resourceId: created.id, metadata: { mode: created.mode, budget } }, tx);
      return created;
    });
    await this.dispatch(run);
    return runView(run);
  }

  /** Wake the orchestrator. The dedupe key collapses duplicate jobs for the same state version. */
  async dispatch(run: { id: string; organization_id: string; state_version: number }): Promise<void> {
    await this.events.notify(run.id);
    await this.queues.enqueueRun({ runId: run.id, organizationId: run.organization_id }, { dedupeKey: `run-${run.id}-v${run.state_version}` }).catch(() => undefined);
  }

  async listForTask(userId: string, taskId: string, limit: number, cursorRaw?: string): Promise<Page<unknown>> {
    await this.access.requireTask(userId, taskId);
    const cursor = decodeCursor(cursorRaw);
    let q = this.database.db.selectFrom('workflow_runs').selectAll().select(cursorUs('created_at').as('cursor_us')).where('task_id', '=', taskId);
    if (cursor) q = q.where(beforeCursor('created_at', 'id', cursor));
    const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    return toPage(rows, limit, ({ cursor_us: _c, ...r }) => runView(r));
  }

  /** Workspace-wide run list (GAP-05), newest first, with task/repository labels for list views. */
  async listForWorkspace(userId: string, workspaceId: string, q: Omit<z.infer<typeof listRunsQuery>, 'workspace_id'>): Promise<Page<unknown>> {
    await this.access.requireWorkspace(userId, workspaceId);
    const cursor = decodeCursor(q.cursor);
    let query = this.database.db
      .selectFrom('workflow_runs as r')
      .innerJoin('engineering_tasks as t', 't.id', 'r.task_id')
      .innerJoin('repositories as repo', 'repo.id', 'r.repository_id')
      .selectAll('r')
      .select(['t.title as task_title', 'repo.full_name as repository_full_name'])
      .select(cursorUs('r.created_at').as('cursor_us'))
      .where('r.organization_id', '=', workspaceId);
    if (q.repository_id) query = query.where('r.repository_id', '=', q.repository_id);
    if (q.task_id) query = query.where('r.task_id', '=', q.task_id);
    if (q.status?.length) query = query.where('r.status', 'in', q.status);
    if (cursor) query = query.where(beforeCursor('r.created_at', 'r.id', cursor));
    const rows = await query.orderBy('r.created_at', 'desc').orderBy('r.id', 'desc').limit(q.limit + 1).execute();
    return toPage(rows, q.limit, ({ cursor_us: _c, task_title, repository_full_name, ...r }) => ({ ...runView(r), task_title, repository_full_name }));
  }

  async get(userId: string, runId: string) {
    const { run } = await this.access.requireRun(userId, runId);
    const [plan, labels, approvals, pr] = await Promise.all([
      this.latestPlan(runId),
      this.database.db
        .selectFrom('engineering_tasks as t')
        .innerJoin('repositories as repo', 'repo.id', 't.repository_id')
        .select(['t.title as task_title', 'repo.full_name as repository_full_name'])
        .where('t.id', '=', run.task_id)
        .executeTakeFirstOrThrow(),
      this.database.db
        .selectFrom('approvals')
        .select(['id', 'approval_type', 'decision', 'subject_hash', 'comment', 'user_id', 'created_at'])
        .where('run_id', '=', runId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
      this.database.db
        .selectFrom('pull_requests')
        .select(['id', 'pr_number', 'pr_url', 'head_branch', 'base_branch', 'created_at'])
        .where('run_id', '=', runId)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    ]);
    return {
      ...runView(run),
      ...labels,
      plan_hash: plan?.content_hash ?? null,
      plan_version: plan?.version ?? null,
      data_disclosure: run.checkpoint.data_disclosure ?? null,
      approvals: approvals.map((a) => ({ ...a, created_at: a.created_at.toISOString() })),
      pull_request: pr ? { ...pr, created_at: pr.created_at.toISOString() } : null,
    };
  }

  async cancel(userId: string, runId: string, reason?: string) {
    const { run } = await this.access.requireRun(userId, runId, 'member');
    if (isTerminal(run.status)) throw Errors.invalidState('This run has already finished.');
    const updated = await this.database.transaction(async (tx) => {
      const current = await this.lock(tx, runId);
      if (isTerminal(current.status)) throw Errors.invalidState('This run has already finished.');
      await tx.updateTable('workflow_runs').set({ cancel_requested_at: new Date() }).where('id', '=', runId).execute();
      const next = await this.transitions.transition(tx, { ...current, cancel_requested_at: new Date() }, 'cancelled', { type: 'user', userId }, { reason: reason ?? 'cancelled by user' });
      await this.audit.record({ organizationId: run.organization_id, actorUserId: userId, action: 'run.cancelled', resourceType: 'run', resourceId: runId, metadata: { from: current.status } }, tx);
      return next;
    });
    // Signals workers: they re-check status before every model/tool action.
    await this.events.notify(runId);
    return runView(updated);
  }

  async retry(userId: string, runId: string) {
    const { run } = await this.access.requireRun(userId, runId, 'member');
    if (!['failed', 'timed_out', 'cancelled'].includes(run.status)) throw Errors.invalidState('Only failed, timed-out or cancelled runs can be retried.');
    const retried = await this.start(userId, run.task_id, { mode: run.mode, base_branch: run.base_branch ?? undefined, budgets: run.budget });
    await this.database.db.updateTable('workflow_runs').set({ retry_of_run_id: runId }).where('id', '=', retried.id).execute();
    return { ...retried, retry_of_run_id: runId };
  }

  // -------------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------------
  private async latestPlan(runId: string) {
    return this.database.db.selectFrom('run_plans').selectAll().where('run_id', '=', runId).orderBy('version', 'desc').limit(1).executeTakeFirst();
  }

  async getPlan(userId: string, runId: string) {
    const { run } = await this.access.requireRun(userId, runId);
    const plan = await this.latestPlan(runId);
    if (!plan) throw Errors.notFound('Plan');
    const approval = await this.database.db
      .selectFrom('approvals')
      .select(['decision', 'user_id', 'comment', 'subject_hash', 'created_at'])
      .where('run_id', '=', runId)
      .where('approval_type', '=', 'plan')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return {
      run_id: runId,
      version: plan.version,
      plan_hash: plan.content_hash,
      source: plan.source,
      created_by: plan.created_by,
      created_at: plan.created_at.toISOString(),
      editable: run.status === 'awaiting_plan_approval',
      plan: plan.content,
      investigation: withResolvedEvidence(run.checkpoint.investigation, run.checkpoint.evidence),
      approval: approval ? { ...approval, created_at: approval.created_at.toISOString() } : null,
    };
  }

  async editPlan(userId: string, runId: string, body: z.infer<typeof editPlanBody>) {
    await this.access.requireRun(userId, runId, 'member');
    const parsed = planSchema.safeParse(body.plan);
    if (!parsed.success) throw Errors.validation({ issues: zodIssues(parsed.error).map((i) => ({ ...i, path: `plan.${i.path}` })) });
    const result = await this.database.transaction(async (tx) => {
      const run = await this.lock(tx, runId);
      if (run.status !== 'awaiting_plan_approval') throw Errors.invalidState('The plan can only be edited while awaiting approval.');
      const current = await tx.selectFrom('run_plans').selectAll().where('run_id', '=', runId).orderBy('version', 'desc').limit(1).executeTakeFirstOrThrow();
      if (current.content_hash !== body.base_plan_hash) throw Errors.conflict('PLAN_CHANGED', 'The plan changed since you loaded it.', { plan_hash: current.content_hash });
      const budget = run.budget as Partial<RunBudget>;
      if (parsed.data.files_to_modify.length > (budget.max_changed_files ?? DEFAULT_RUN_BUDGET.max_changed_files)) {
        throw Errors.unprocessable('PLAN_EXCEEDS_BUDGET', 'The plan modifies more files than the run budget allows.');
      }
      const hash = planHash(parsed.data);
      const row = await tx
        .insertInto('run_plans')
        .values({ run_id: runId, version: current.version + 1, content: json(parsed.data), content_hash: hash, source: 'user_edit', created_by: userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.events.emit(tx, run, 'approval.required', { approval_type: 'plan', plan_hash: hash, plan_version: row.version, reason: 'plan edited' });
      await this.audit.record({ organizationId: run.organization_id, actorUserId: userId, action: 'plan.edited', resourceType: 'run', resourceId: runId, metadata: { version: row.version, plan_hash: hash } }, tx);
      return row;
    });
    await this.events.notify(runId);
    return { run_id: runId, version: result.version, plan_hash: result.content_hash, source: result.source, plan: result.content };
  }

  /**
   * Human plan approval (FR-WF-005). The approval is bound to the exact plan
   * hash the human reviewed; any later edit invalidates it.
   */
  async decidePlan(userId: string, runId: string, body: z.infer<typeof planApprovalBody>) {
    await this.access.requireRun(userId, runId, 'member');
    const updated = await this.database.transaction(async (tx) => {
      const run = await this.lock(tx, runId);
      if (run.status !== 'awaiting_plan_approval') throw Errors.invalidState('This run is not awaiting plan approval.');
      const plan = await tx.selectFrom('run_plans').selectAll().where('run_id', '=', runId).orderBy('version', 'desc').limit(1).executeTakeFirstOrThrow();
      if (body.decision === 'approved' && body.plan_hash !== plan.content_hash) {
        throw Errors.conflict('PLAN_CHANGED', 'The plan changed since you reviewed it. Review the current version.', { plan_hash: plan.content_hash });
      }
      await tx
        .insertInto('approvals')
        .values({ run_id: runId, user_id: userId, approval_type: 'plan', decision: body.decision, comment: body.comment ?? null, subject_hash: plan.content_hash })
        .execute();
      const next =
        body.decision === 'approved'
          ? await this.transitions.transition(tx, run, 'preparing_workspace', { type: 'user', userId }, { reason: 'plan approved', checkpointPatch: { approved_plan_hash: plan.content_hash, approved_plan_version: plan.version } })
          : await this.transitions.transition(tx, run, 'rejected', { type: 'user', userId }, { reason: body.comment ?? 'plan rejected' });
      await this.audit.record(
        { organizationId: run.organization_id, actorUserId: userId, action: `plan.${body.decision}`, resourceType: 'run', resourceId: runId, metadata: { plan_hash: plan.content_hash, version: plan.version } },
        tx,
      );
      return next;
    });
    if (updated.status === 'preparing_workspace') await this.dispatch(updated);
    else await this.events.notify(runId);
    return runView(updated);
  }

  // -------------------------------------------------------------------------
  // Steps and artifacts
  // -------------------------------------------------------------------------
  async steps(userId: string, runId: string) {
    await this.access.requireRun(userId, runId);
    const steps = await this.database.db.selectFrom('agent_steps').selectAll().where('run_id', '=', runId).orderBy('sequence_number').limit(200).execute();
    const tools = steps.length
      ? await this.database.db
          .selectFrom('tool_executions')
          .selectAll()
          .where(
            'agent_step_id',
            'in',
            steps.map((s) => s.id),
          )
          .orderBy('created_at')
          .execute()
      : [];
    return steps.map((s) => ({
      id: s.id,
      sequence_number: s.sequence_number,
      agent_type: s.agent_type,
      status: s.status,
      prompt_version: s.prompt_version,
      provider: s.provider,
      model: s.model,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      duration_ms: s.duration_ms,
      error_code: s.error_code,
      input: s.input_redacted,
      output: s.output_redacted,
      started_at: s.started_at?.toISOString() ?? null,
      ended_at: s.ended_at?.toISOString() ?? null,
      tool_calls: tools
        .filter((t) => t.agent_step_id === s.id)
        .map((t) => ({ id: t.id, tool_name: t.tool_name, status: t.status, input: t.input_redacted, output: t.output_redacted, duration_ms: t.duration_ms, created_at: t.created_at.toISOString() })),
    }));
  }

  async artifacts(userId: string, runId: string) {
    await this.access.requireRun(userId, runId);
    const [patches, verifications] = await Promise.all([
      this.database.db.selectFrom('patches').select(['id', 'patch_hash', 'base_commit_sha', 'changed_files', 'additions', 'deletions', 'status', 'created_at']).where('run_id', '=', runId).orderBy('created_at').execute(),
      this.database.db.selectFrom('verification_runs').select(['id', 'profile_id', 'status', 'exit_code', 'duration_ms', 'created_at']).where('run_id', '=', runId).orderBy('created_at').execute(),
    ]);
    return {
      patches: patches.map((p) => ({ ...p, type: 'patch', created_at: p.created_at.toISOString() })),
      verification_logs: verifications.map((v) => ({ ...v, type: 'verification', created_at: v.created_at.toISOString() })),
    };
  }

  async lock(tx: Tx, runId: string): Promise<WorkflowRun> {
    return tx.selectFrom('workflow_runs').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
  }

  /** Re-enqueue runs in worker states whose queue entry may have been lost. */
  async recover(staleSeconds = 120): Promise<number> {
    const rows = await this.database.db
      .selectFrom('workflow_runs')
      .select(['id', 'organization_id', 'state_version'])
      .where('status', 'in', [...WORKER_STATES])
      .where('updated_at', '<', sql<Date>`now() - ${`${staleSeconds} seconds`}::interval`)
      .limit(100)
      .execute();
    for (const r of rows) {
      const key = `run-${r.id}-v${r.state_version}`;
      const existing = await this.queues.queue('engineering-run').getJob(key);
      const state = existing ? await existing.getState() : 'missing';
      if (['waiting', 'active', 'delayed', 'prioritized'].includes(state)) continue;
      if (existing) await existing.remove().catch(() => undefined);
      await this.queues.enqueueRun({ runId: r.id, organizationId: r.organization_id }, { dedupeKey: key });
    }
    return rows.length;
  }
}

export { HUMAN_STATES };
