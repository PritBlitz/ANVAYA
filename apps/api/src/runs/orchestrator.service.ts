import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AiServiceError } from '../ai/ai-client.js';
import { logger } from '../common/logger.js';
import { RedisService } from '../common/redis.service.js';
import { json, type WorkflowRun } from '../database/types.js';
import { normalizePath } from '../indexing/classifier.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { parseSnapshot, planningContext } from '../templates/templates.js';
import { type Investigation, investigationSchema, type MigrationPlanOutput, migrationPlanOutputSchema, type Plan, planHash, planSchema, type RunBudget } from './run.schemas.js';
import { RunNoLongerActive, StageFailure, StageToolkit } from './stage-toolkit.js';
import { HUMAN_STATES, isTerminal } from './state-machine.js';

export { RunNoLongerActive, StageFailure } from './stage-toolkit.js';

const log = logger('orchestrator');
const LOCK_TTL_MS = 10 * 60 * 1000;
const RETRIEVAL_TOP_K = 10;

/** Post-approval stages (workspace, patch, verification, review). */
export abstract class ExecutionStages {
  abstract advance(run: WorkflowRun): Promise<'progressed' | 'waiting'>;
  /** Releases execution resources (e.g. workspace) for a finished run. */
  abstract release(runId: string): Promise<void>;
}

/** Used when no execution driver is configured: approved runs fail explicitly. */
@Injectable()
export class UnavailableExecutionStages extends ExecutionStages {
  async advance(run: WorkflowRun): Promise<'progressed' | 'waiting'> {
    throw new StageFailure('EXECUTION_NOT_AVAILABLE', `The isolated execution plane is not configured; the run cannot proceed past '${run.status}'.`);
  }
  async release(): Promise<void> {}
}

/**
 * Durable workflow orchestrator (ARCHITECTURE §4.5, AI_WORKFLOW §3).
 *
 * Each stage persists its output in the run checkpoint in the same transaction
 * as the state transition, so a crashed worker resumes from the last safe
 * checkpoint. Before every model/tool action the run is re-read: cancellation
 * or any concurrent transition stops further work. Model output never changes
 * run state directly — it is validated, then deterministic code decides.
 */
@Injectable()
export class OrchestratorService {
  constructor(
    private readonly kit: StageToolkit,
    private readonly redis: RedisService,
    private readonly retrieval: RetrievalService,
    private readonly execution: ExecutionStages,
  ) {}

  /** Advances a run until it waits for a human, finishes, or needs another job. */
  async advance(runId: string): Promise<void> {
    const lockKey = `run-lock:${runId}`;
    const token = randomUUID();
    const acquired = await this.redis.client.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired !== 'OK') {
      log.info({ run_id: runId }, 'run is being advanced by another worker');
      return;
    }
    try {
      for (let i = 0; i < 30; i++) {
        const run = await this.kit.load(runId);
        if (!run) return;
        if (isTerminal(run.status) || run.cancel_requested_at) {
          await this.execution.release(runId);
          return;
        }
        if (HUMAN_STATES.includes(run.status)) return;
        if (await this.kit.enforceDeadline(run)) {
          await this.execution.release(runId);
          return;
        }
        await this.redis.client.pexpire(lockKey, LOCK_TTL_MS);
        const progressed = await this.step(run);
        if (!progressed) return;
      }
    } finally {
      await this.redis.client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, token).catch(() => undefined);
    }
  }

  private async step(run: WorkflowRun): Promise<boolean> {
    try {
      switch (run.status) {
        case 'queued':
          await this.kit.move(run, 'retrieving_context', 'context retrieval started');
          return true;
        case 'retrieving_context':
          await this.retrieveContext(run);
          return true;
        case 'investigating':
          await this.investigate(run);
          return true;
        case 'planning':
          await this.plan(run);
          return true;
        default:
          return (await this.execution.advance(run)) === 'progressed';
      }
    } catch (err) {
      if (err instanceof RunNoLongerActive) return true; // re-read; the loop exits on terminal/human states
      if (err instanceof StageFailure) {
        await this.kit.failRun(run.id, err.code, err.message);
        await this.execution.release(run.id);
        return false;
      }
      if (err instanceof AiServiceError) {
        // FR-AI-009: provider failures fail the run gracefully with a clear reason; the user may retry.
        const summary = err.retryable
          ? 'The model provider was unavailable or timed out. No fallback provider was used; retry when it is available.'
          : `The model request failed (${err.code}).`;
        await this.kit.failRun(run.id, err.code, summary);
        await this.execution.release(run.id);
        return false;
      }
      throw err; // infrastructure error → queue retry; state is unchanged and resumable
    }
  }

  // ---------------------------------------------------------------------------
  // Stage: Context Retriever (deterministic, no LLM)
  // ---------------------------------------------------------------------------
  private async retrieveContext(run: WorkflowRun): Promise<void> {
    const task = await this.kit.task(run);
    const repo = await this.kit.database.db.selectFrom('repositories').selectAll().where('id', '=', run.repository_id).executeTakeFirstOrThrow();
    if (repo.status !== 'connected') throw new StageFailure('REPOSITORY_NOT_CONNECTED', 'The repository is no longer connected.');
    const commitSha = typeof run.checkpoint.commit_sha === 'string' ? run.checkpoint.commit_sha : 'latest';
    const stepId = await this.kit.startStep(run, 'context_retriever', { query: task.title });
    const toolStarted = Date.now();
    const toolId = await this.kit.startTool(run, stepId, 'search_repository', { query: task.title, top_k: RETRIEVAL_TOP_K, snapshot: commitSha });
    const res = await this.retrieval.search(repo, { query: `${task.title}\n${task.description}`.slice(0, 500), snapshot: commitSha, topK: RETRIEVAL_TOP_K, mode: 'hybrid' });
    const refs = res.results.map((r) => ({ id: r.chunk_id, path: r.file_path, start_line: r.start_line, end_line: r.end_line, commit_sha: r.commit_sha, content_hash: r.content_hash, symbol: r.symbol_name }));
    await this.kit.database.transaction(async (tx) => {
      const current = await this.kit.guard(tx, run);
      await this.kit.finishTool(tx, current, toolId, 'succeeded', { results: refs.length, semantic: res.retrieval.semantic }, Date.now() - toolStarted, 'search_repository');
      await this.kit.finishStep(tx, stepId, 'succeeded', { evidence: refs, retrieval: res.retrieval }, null);
      await this.kit.events.emit(tx, current, 'retrieval.completed', { count: refs.length, commit_sha: commitSha, semantic: res.retrieval.semantic, evidence: refs.slice(0, 20) });
      await this.kit.transitions.transition(tx, current, 'investigating', { type: 'worker' }, { reason: `retrieved ${refs.length} evidence item(s)`, checkpointPatch: { evidence: refs } });
    });
    await this.kit.events.notify(run.id);
  }

  // ---------------------------------------------------------------------------
  // Stage: Repository Investigator
  // ---------------------------------------------------------------------------
  private async investigate(run: WorkflowRun): Promise<void> {
    const task = await this.kit.task(run);
    const evidence = await this.kit.loadEvidence(run);
    const template = planningContext(parseSnapshot(task.template));
    const gen = await this.kit.callModel(run, 'investigator', { task: 'investigation', intent: this.kit.intent(task), untrusted_inputs: this.kit.untrusted(task), evidence, ...(template ? { context: { template } } : {}) });
    const parsed = investigationSchema.safeParse(gen.output);
    if (!parsed.success) throw new StageFailure('INVALID_MODEL_OUTPUT', 'The investigation output failed validation.');
    const known = new Set(evidence.map((e) => e.id));
    const investigation: Investigation = {
      ...parsed.data,
      findings: parsed.data.findings.map((f) => ({ ...f, evidence_ids: f.evidence_ids.filter((id) => known.has(id)) })),
      candidate_files: parsed.data.candidate_files.map((p) => normalizePath(p)).filter((p): p is string => p !== null),
    };
    await this.kit.database.transaction(async (tx) => {
      const current = await this.kit.guard(tx, run);
      await this.kit.completeModelStep(tx, current, gen, investigation);
      await this.kit.transitions.transition(tx, current, 'planning', { type: 'worker' }, { reason: 'investigation completed', checkpointPatch: { investigation } });
    });
    await this.kit.events.notify(run.id);
  }

  // ---------------------------------------------------------------------------
  // Stage: Engineering Planner (schema + scope validated; at most one re-plan)
  // ---------------------------------------------------------------------------
  private async plan(run: WorkflowRun): Promise<void> {
    const task = await this.kit.task(run);
    const budget = this.kit.budget(run);
    const evidence = await this.kit.loadEvidence(run);
    const snapshot = parseSnapshot(task.template);
    const template = planningContext(snapshot);
    // Plan-only workflow (migration plan template): a richer plan schema, and nothing runs after approval.
    const planOnly = snapshot?.workflow === 'migration_plan';
    const known = new Set(evidence.map((e) => e.id));
    let note: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = await this.kit.callModel(run, planOnly ? 'migration_planner' : 'planner', {
        task: planOnly ? 'migration_plan' : 'planning',
        intent: this.kit.intent(task),
        untrusted_inputs: this.kit.untrusted(task),
        evidence,
        context: {
          investigation: run.checkpoint.investigation ?? null,
          ...(planOnly ? { plan_only: true } : { max_changed_files: budget.max_changed_files }),
          ...(template ? { template } : {}),
          ...(note ? { revision_required: note } : {}),
        },
      });
      const parsed = planOnly ? toMigrationPlan(gen.output, known) : planSchema.safeParse(gen.output);
      const problem = !parsed.success ? 'The plan did not match the plan schema.' : this.scopeProblem(parsed.data, budget, planOnly);
      if (parsed.success && !problem) {
        const plan = parsed.data;
        const hash = planHash(plan);
        await this.kit.database.transaction(async (tx) => {
          const current = await this.kit.guard(tx, run);
          await this.kit.completeModelStep(tx, current, gen, plan);
          await tx.insertInto('run_plans').values({ run_id: run.id, version: 1, content: json(plan), content_hash: hash, source: 'agent', created_by: null }).execute();
          const next = await this.kit.transitions.transition(tx, current, 'awaiting_plan_approval', { type: 'worker' }, { reason: 'plan proposed' });
          await this.kit.events.emit(tx, next, 'approval.required', { approval_type: 'plan', plan_hash: hash, plan_version: 1 });
        });
        await this.kit.events.notify(run.id);
        return;
      }
      await this.kit.database.transaction(async (tx) => {
        const current = await this.kit.guard(tx, run);
        await this.kit.completeModelStep(tx, current, gen, { rejected_plan: true, problem }, 'failed', 'INVALID_PLAN');
      });
      note = problem;
      run = (await this.kit.load(run.id))!;
    }
    throw new StageFailure('INVALID_PLAN', `The planner did not produce a valid plan within scope: ${note ?? 'unknown'}`);
  }

  private scopeProblem(plan: Plan, budget: RunBudget, planOnly = false): string | null {
    // A plan-only run changes no files, so only the schema's own limits apply to it.
    if (!planOnly && plan.files_to_modify.length > budget.max_changed_files) return `The plan modifies ${plan.files_to_modify.length} files; the limit is ${budget.max_changed_files}.`;
    const declared = new Set(plan.files_to_modify);
    const undeclared = plan.steps.flatMap((s) => s.files).filter((f) => !declared.has(f));
    if (undeclared.length > 0) return `Steps reference files not listed in files_to_modify: ${undeclared.slice(0, 3).join(', ')}.`;
    return null;
  }
}

/**
 * Converts the AI service's migration-plan output into the run's Plan (the approval artifact):
 * per-step rollback moves into `migration.step_rollback`, evidence ids the run never retrieved
 * are dropped, and paths are normalized (unsafe ones removed). Validated by planSchema afterwards.
 */
export function toMigrationPlan(output: unknown, knownEvidence: ReadonlySet<string>): ReturnType<typeof planSchema.safeParse> {
  const raw = migrationPlanOutputSchema.safeParse(output);
  if (!raw.success) return planSchema.safeParse(null);
  const m: MigrationPlanOutput = raw.data;
  const paths = (list: string[]) => [...new Set(list.map((p) => normalizePath(p)).filter((p): p is string => p !== null))];
  const files = paths(m.files_to_modify);
  const declared = new Set(files);
  return planSchema.safeParse({
    objective: m.objective,
    assumptions: m.assumptions,
    steps: m.steps.map((st) => ({ id: st.id, description: st.description, files: paths(st.files).filter((f) => declared.has(f)), verification: st.verification })),
    files_to_modify: files,
    tests: m.tests,
    risks: m.risks,
    out_of_scope: m.out_of_scope,
    migration: {
      affected_areas: m.affected_areas.map((a) => ({ area: a.area, description: a.description, files: paths(a.files), evidence_ids: a.evidence_ids.filter((id) => knownEvidence.has(id)) })),
      prerequisites: m.prerequisites,
      step_rollback: m.steps.map((st) => ({ step_id: st.id, rollback: st.rollback })),
      rollback_strategy: m.rollback_strategy,
    },
  });
}
