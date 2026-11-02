import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Errors } from '../common/errors.js';
import { metrics } from '../common/metrics.js';
import type { Tx } from '../database/database.service.js';
import { json, type RunStatus, type TaskStatus, type WorkflowRun } from '../database/types.js';
import { RunEventsService } from './run-events.service.js';
import { canTransition, isTerminal, stageOf } from './state-machine.js';

export interface TransitionActor {
  type: 'user' | 'system' | 'worker';
  userId?: string | null;
}

export interface TransitionOptions {
  reason?: string;
  errorCode?: string;
  errorSummary?: string;
  checkpointPatch?: Record<string, unknown>;
}

const TERMINAL_EVENT: Partial<Record<RunStatus, 'run.completed' | 'run.failed' | 'run.cancelled'>> = {
  completed: 'run.completed',
  completed_without_pr: 'run.completed',
  failed: 'run.failed',
  timed_out: 'run.failed',
  rejected: 'run.completed',
  cancelled: 'run.cancelled',
};

const TASK_STATUS_FOR: Partial<Record<RunStatus, TaskStatus>> = {
  completed: 'completed',
  completed_without_pr: 'completed',
  failed: 'failed',
  timed_out: 'failed',
  cancelled: 'cancelled',
  rejected: 'open',
};

/**
 * The only code path that changes a run's status. Validates against the
 * state machine, applies optimistic concurrency on `state_version`, and in the
 * same transaction records the transition (actor, version, reason) and emits
 * the corresponding events. Callers must `notify` after commit.
 */
@Injectable()
export class RunTransitionsService {
  constructor(private readonly events: RunEventsService) {}

  async transition(tx: Tx, run: WorkflowRun, to: RunStatus, actor: TransitionActor, opts: TransitionOptions = {}): Promise<WorkflowRun> {
    if (!canTransition(run.status, to)) {
      throw Errors.invalidState(isTerminal(run.status) ? 'This run has already finished.' : `A run cannot move from ${run.status} to ${to}.`, { from: run.status, to });
    }
    const terminal = isTerminal(to);
    const updated = await tx
      .updateTable('workflow_runs')
      .set({
        status: to,
        current_stage: stageOf(to),
        state_version: sql`state_version + 1`,
        ...(run.started_at === null && to !== 'queued' ? { started_at: new Date() } : {}),
        ...(terminal ? { ended_at: new Date() } : {}),
        ...(opts.errorCode ? { error_code: opts.errorCode, error_summary: opts.errorSummary ?? null } : {}),
        ...(opts.checkpointPatch ? { checkpoint: sql`checkpoint || ${json(opts.checkpointPatch)}::jsonb` } : {}),
      })
      .where('id', '=', run.id)
      .where('state_version', '=', run.state_version)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw Errors.conflict('RUN_STATE_CONFLICT', 'The run changed concurrently; reload and try again.');
    metrics.runTransitions.inc({ to });

    await tx
      .insertInto('run_state_transitions')
      .values({ run_id: run.id, from_status: run.status, to_status: to, state_version: updated.state_version, actor_type: actor.type, actor_user_id: actor.userId ?? null, reason: opts.reason ?? null })
      .execute();
    await this.events.emit(tx, run, 'run.status.changed', { from: run.status, status: to, state_version: updated.state_version, reason: opts.reason ?? null });
    const prevStage = stageOf(run.status);
    if (updated.current_stage && updated.current_stage !== prevStage) await this.events.emit(tx, run, 'run.stage.changed', { stage: updated.current_stage });
    const terminalEvent = TERMINAL_EVENT[to];
    if (terminalEvent) await this.events.emit(tx, run, terminalEvent, { status: to, error_code: opts.errorCode ?? null, error_summary: opts.errorSummary ?? null });

    const taskStatus = terminal ? TASK_STATUS_FOR[to] : 'active';
    if (taskStatus) {
      await tx.updateTable('engineering_tasks').set({ status: taskStatus }).where('id', '=', run.task_id).where('status', '!=', 'archived').execute();
    }
    return updated;
  }
}
