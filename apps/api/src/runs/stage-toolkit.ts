import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AiClient, type EvidenceItem, type GenerationRequest, type GenerationResponse, AiServiceError } from '../ai/ai-client.js';
import { AiPolicyService } from '../ai/ai-policy.service.js';
import { QuotaService } from '../ai/quota.service.js';
import { UsageService } from '../ai/usage.service.js';
import { logger } from '../common/logger.js';
import { redactValue } from '../common/redact.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { type EngineeringTask, json, type JsonObject, type TaskSourceType, type WorkflowRun } from '../database/types.js';
import { RunEventsService } from './run-events.service.js';
import { DEFAULT_RUN_BUDGET, type RunBudget } from './run.schemas.js';
import { RunTransitionsService } from './run-transitions.service.js';
import { isTerminal } from './state-machine.js';
import { untrustedSourceInputs } from './task-sources.js';

const log = logger('orchestrator');

const DESCRIPTION_LABELS: Record<TaskSourceType, string> = {
  manual: 'task_description',
  github_issue: 'github_issue_body',
  pull_request: 'github_pull_request_body',
  failing_check: 'github_check_run_output',
};

/** States where the run waits for a human decision; they don't spend the duration budget. */
const HUMAN_GATES: ReadonlySet<string> = new Set(['awaiting_plan_approval', 'awaiting_pr_approval']);

/** A stage failed for a known reason; the run fails with this code. */
export class StageFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** The run was cancelled or moved concurrently; stop without changing state. */
export class RunNoLongerActive extends Error {}

export type ModelResult = GenerationResponse & { stepId: string };

/**
 * Shared, guarded building blocks for workflow stages: agent-step and tool
 * recording, budget-checked model calls, cancellation checks and transitions.
 */
@Injectable()
export class StageToolkit {
  constructor(
    readonly database: DatabaseService,
    readonly transitions: RunTransitionsService,
    readonly events: RunEventsService,
    private readonly ai: AiClient,
    private readonly usage: UsageService,
    private readonly policies: AiPolicyService,
    private readonly quotas: QuotaService,
  ) {}

  // ---------------------------------------------------------------------------
  // Model calls, steps and tools
  // ---------------------------------------------------------------------------
  intent(task: EngineeringTask): Record<string, unknown> {
    // Only application-structured fields here; user/issue text goes to untrusted_inputs.
    return { objective_title: task.title, source_type: task.source_type, external_number: task.external_number, external_id: task.external_id };
  }

  /** Task text and imported GitHub context, each as a labelled untrusted input (CLAUDE.md §9). */
  untrusted(task: EngineeringTask): Array<{ label: string; content: string }> {
    return [{ label: DESCRIPTION_LABELS[task.source_type], content: task.description }, ...untrustedSourceInputs(task.source_type, task.source_context)];
  }

  budget(run: WorkflowRun): RunBudget {
    return { ...DEFAULT_RUN_BUDGET, ...(run.budget as Partial<RunBudget>) };
  }

  /**
   * Seconds the run has spent working, which is what `max_duration_seconds` limits. Time parked
   * at an approval gate waits on a person, not on the agent, so it is excluded: otherwise a
   * reviewer who takes longer than the budget to approve a plan times the run out the moment
   * they approve. An open gate (the run is still waiting) counts up to now.
   */
  async activeSeconds(run: WorkflowRun): Promise<number> {
    if (!run.started_at) return 0;
    const rows = await this.database.db
      .selectFrom('run_state_transitions')
      .select(['to_status', 'created_at'])
      .where('run_id', '=', run.id)
      .orderBy('id')
      .execute();
    const now = Date.now();
    let waitedMs = 0;
    rows.forEach((row, i) => {
      if (!HUMAN_GATES.has(row.to_status)) return;
      const end = rows[i + 1]?.created_at.getTime() ?? now;
      waitedMs += Math.max(0, end - row.created_at.getTime());
    });
    return Math.max(0, (now - run.started_at.getTime() - waitedMs) / 1000);
  }

  async remainingSeconds(run: WorkflowRun): Promise<number> {
    return this.budget(run).max_duration_seconds - (await this.activeSeconds(run));
  }

  async callModel(run: WorkflowRun, agentType: string, req: Omit<GenerationRequest, 'mode' | 'provider' | 'model' | 'budget'>): Promise<GenerationResponse & { stepId: string }> {
    const budget = this.budget(run);
    const steps = Number(run.usage_summary.agent_steps ?? 0);
    if (steps >= budget.max_steps) throw new StageFailure('BUDGET_EXHAUSTED', `The run reached its step budget (${budget.max_steps}).`);
    const remainingSeconds = await this.remainingSeconds(run);
    if (remainingSeconds < 10) throw new StageFailure('BUDGET_EXHAUSTED', 'The run has no time budget left for another model call.');
    // FR-OBS-004: the workspace's daily token quota is checked before every model call.
    const quotaError = await this.quotas.tokenQuotaError(run.organization_id);
    if (quotaError) throw new StageFailure('QUOTA_EXCEEDED', `${quotaError.message} Retry the run after the reset.`);
    // One call may use the rest of the run's time, but never more than the workspace's
    // per-request timeout (the same limit Q&A uses, and at most what the AI service accepts).
    const requestTimeout = (await this.policies.load(run.organization_id)).limits.request_timeout_seconds;
    const stepId = await this.startStep(run, agentType, { task: req.task, evidence_ids: req.evidence.map((e) => e.id) });
    await this.assertActive(run.id);
    try {
      const gen = await this.ai.generate({
        ...req,
        mode: run.mode,
        provider: run.provider,
        model: run.model,
        budget: { max_input_tokens: budget.max_input_tokens, max_output_tokens: budget.max_output_tokens, timeout_seconds: Math.max(10, Math.floor(Math.min(remainingSeconds, requestTimeout))) },
      });
      await this.usage.record({
        organizationId: run.organization_id,
        runId: run.id,
        provider: gen.provider,
        model: gen.model,
        operation: req.task,
        inputTokens: gen.usage.input_tokens,
        outputTokens: gen.usage.output_tokens,
        estimatedCostMicrounits: gen.usage.estimated_cost_microunits ?? null,
        durationMs: gen.duration_ms,
      });
      return { ...gen, stepId };
    } catch (err) {
      await this.database.transaction(async (tx) => {
        await this.finishStep(tx, stepId, 'failed', null, err instanceof AiServiceError ? err.code : 'ERROR');
        await this.events.emit(tx, run, 'agent.failed', { agent: agentType, error_code: err instanceof AiServiceError ? err.code : 'ERROR' });
      });
      await this.events.notify(run.id);
      throw err;
    }
  }

  async completeModelStep(tx: Tx, run: WorkflowRun, gen: GenerationResponse & { stepId: string }, output: JsonObject, status: 'succeeded' | 'failed' = 'succeeded', errorCode: string | null = null): Promise<void> {
    await tx
      .updateTable('agent_steps')
      .set({
        status,
        output_redacted: json(redactValue(output)),
        provider: gen.provider,
        model: gen.model,
        prompt_version: gen.prompt_version,
        input_tokens: gen.usage.input_tokens,
        output_tokens: gen.usage.output_tokens,
        duration_ms: gen.duration_ms,
        ended_at: new Date(),
        error_code: errorCode,
      })
      .where('id', '=', gen.stepId)
      .execute();
    const u = run.usage_summary;
    await tx
      .updateTable('workflow_runs')
      .set({
        usage_summary: json({
          input_tokens: Number(u.input_tokens ?? 0) + gen.usage.input_tokens,
          output_tokens: Number(u.output_tokens ?? 0) + gen.usage.output_tokens,
          model_calls: Number(u.model_calls ?? 0) + 1,
          agent_steps: Number(u.agent_steps ?? 0) + 1,
        }),
        provider: gen.provider,
        model: gen.model,
      })
      .where('id', '=', run.id)
      .execute();
    const agent = await tx.selectFrom('agent_steps').select('agent_type').where('id', '=', gen.stepId).executeTakeFirstOrThrow();
    await this.events.emit(tx, run, status === 'succeeded' ? 'agent.completed' : 'agent.failed', {
      agent: agent.agent_type,
      provider: gen.provider,
      model: gen.model,
      input_tokens: gen.usage.input_tokens,
      output_tokens: gen.usage.output_tokens,
      duration_ms: gen.duration_ms,
      error_code: errorCode,
    });
  }

  async startStep(run: WorkflowRun, agentType: string, input: JsonObject): Promise<string> {
    const id = await this.database.transaction(async (tx) => {
      const next = await tx.selectFrom('agent_steps').select(sql<number>`coalesce(max(sequence_number), 0) + 1`.as('n')).where('run_id', '=', run.id).executeTakeFirstOrThrow();
      const row = await tx
        .insertInto('agent_steps')
        .values({ run_id: run.id, sequence_number: Number(next.n), agent_type: agentType, status: 'running', input_redacted: json(redactValue(input)), started_at: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.events.emit(tx, run, 'agent.started', { agent: agentType, step_id: row.id });
      return row.id;
    });
    await this.events.notify(run.id);
    return id;
  }

  async finishStep(tx: Tx, stepId: string, status: 'succeeded' | 'failed', output: JsonObject | null, errorCode: string | null): Promise<void> {
    await tx
      .updateTable('agent_steps')
      .set({ status, output_redacted: output ? json(redactValue(output)) : null, error_code: errorCode, ended_at: new Date(), duration_ms: sql`(extract(epoch from (now() - started_at)) * 1000)::bigint` })
      .where('id', '=', stepId)
      .execute();
  }

  async startTool(run: WorkflowRun, stepId: string, tool: string, input: JsonObject): Promise<string> {
    const id = await this.database.transaction(async (tx) => {
      const row = await tx.insertInto('tool_executions').values({ agent_step_id: stepId, tool_name: tool, status: 'started', input_redacted: json(redactValue(input)) }).returning('id').executeTakeFirstOrThrow();
      await this.events.emit(tx, run, 'tool.started', { tool, step_id: stepId });
      return row.id;
    });
    await this.events.notify(run.id);
    return id;
  }

  async finishTool(tx: Tx, run: WorkflowRun, toolId: string, status: 'succeeded' | 'failed', output: JsonObject, durationMs: number, tool: string): Promise<void> {
    await tx.updateTable('tool_executions').set({ status, output_redacted: json(redactValue(output)), duration_ms: durationMs }).where('id', '=', toolId).execute();
    await this.events.emit(tx, run, 'tool.completed', { tool, status, duration_ms: durationMs });
  }

  /** Evidence content is re-read from the snapshot by chunk id (never stored in the checkpoint). */
  async loadEvidence(run: WorkflowRun): Promise<EvidenceItem[]> {
    const refs = (Array.isArray(run.checkpoint.evidence) ? run.checkpoint.evidence : []) as Array<{ id: string }>;
    if (refs.length === 0) return [];
    const rows = await this.database.db
      .selectFrom('code_chunks as c')
      .innerJoin('repository_files as f', 'f.id', 'c.repository_file_id')
      .innerJoin('repository_snapshots as s', 's.id', 'c.snapshot_id')
      .select(['c.id', 'f.path', 'c.start_line', 'c.end_line', 's.commit_sha', 'f.content_hash', 'c.language', 'c.symbol_name', 'c.content'])
      .where(
        'c.id',
        'in',
        refs.map((r) => r.id),
      )
      .where('c.repository_id', '=', run.repository_id)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return refs
      .map((r) => byId.get(r.id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map((r) => ({ id: r.id, path: r.path, start_line: r.start_line, end_line: r.end_line, commit_sha: r.commit_sha, content_hash: r.content_hash, language: r.language, symbol: r.symbol_name, content: r.content }));
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------
  async load(runId: string): Promise<WorkflowRun | undefined> {
    return this.database.db.selectFrom('workflow_runs').selectAll().where('id', '=', runId).executeTakeFirst();
  }

  async task(run: WorkflowRun): Promise<EngineeringTask> {
    return this.database.db.selectFrom('engineering_tasks').selectAll().where('id', '=', run.task_id).where('organization_id', '=', run.organization_id).executeTakeFirstOrThrow();
  }

  /** Re-read before any model/tool action: cancellation or a concurrent transition stops work. */
  async assertActive(runId: string): Promise<void> {
    const r = await this.load(runId);
    if (!r || isTerminal(r.status) || r.cancel_requested_at) throw new RunNoLongerActive();
  }

  /** Locks the run row and verifies it has not moved since this stage began. */
  async guard(tx: Tx, run: WorkflowRun): Promise<WorkflowRun> {
    const current = await tx.selectFrom('workflow_runs').selectAll().where('id', '=', run.id).forUpdate().executeTakeFirstOrThrow();
    if (current.status !== run.status || current.cancel_requested_at || current.state_version !== run.state_version) throw new RunNoLongerActive();
    return current;
  }

  async move(run: WorkflowRun, to: WorkflowRun['status'], reason: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const current = await this.guard(tx, run);
      await this.transitions.transition(tx, current, to, { type: 'worker' }, { reason });
    });
    await this.events.notify(run.id);
  }

  async enforceDeadline(run: WorkflowRun): Promise<boolean> {
    const budget = this.budget(run);
    if (!run.started_at || (await this.activeSeconds(run)) <= budget.max_duration_seconds) return false;
    await this.database.transaction(async (tx) => {
      const current = await tx.selectFrom('workflow_runs').selectAll().where('id', '=', run.id).forUpdate().executeTakeFirstOrThrow();
      if (isTerminal(current.status)) return;
      await this.transitions.transition(tx, current, 'timed_out', { type: 'worker' }, { reason: 'duration budget exceeded', errorCode: 'TIMED_OUT', errorSummary: `The run exceeded its ${budget.max_duration_seconds}s budget.` });
    });
    await this.events.notify(run.id);
    return true;
  }

  async failRun(runId: string, code: string, summary: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const current = await tx.selectFrom('workflow_runs').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
      if (isTerminal(current.status) || current.cancel_requested_at) return;
      await this.transitions.transition(tx, current, 'failed', { type: 'worker' }, { reason: summary, errorCode: code, errorSummary: summary });
    });
    await this.events.notify(runId);
    log.warn({ run_id: runId, code }, 'run failed');
  }
}
