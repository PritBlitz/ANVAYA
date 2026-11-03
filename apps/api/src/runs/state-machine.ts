import { RUN_TERMINAL_STATUSES, type RunStatus } from '../database/types.js';

/**
 * Central workflow state machine (ARCHITECTURE §6). Every transition in the
 * system is validated against this table; terminal states have no exits.
 */
export const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['retrieving_context', 'failed', 'cancelled', 'timed_out'],
  retrieving_context: ['investigating', 'failed', 'cancelled', 'timed_out'],
  investigating: ['planning', 'failed', 'cancelled', 'timed_out'],
  planning: ['awaiting_plan_approval', 'failed', 'cancelled', 'timed_out'],
  // completed_without_pr here is only taken by plan-only (migration plan) runs: the approved plan
  // is the deliverable and nothing is executed (ADR-0001 addendum, 2026-11-03).
  awaiting_plan_approval: ['preparing_workspace', 'completed_without_pr', 'rejected', 'cancelled', 'timed_out'],
  preparing_workspace: ['implementing', 'failed', 'cancelled', 'timed_out'],
  implementing: ['verifying', 'failed', 'cancelled', 'timed_out'],
  // verifying/reviewing may loop back to implementing for a bounded repair attempt.
  verifying: ['reviewing', 'implementing', 'failed', 'cancelled', 'timed_out'],
  reviewing: ['awaiting_pr_approval', 'implementing', 'failed', 'cancelled', 'timed_out'],
  awaiting_pr_approval: ['creating_pr', 'completed_without_pr', 'cancelled', 'timed_out'],
  // A retryable GitHub failure returns to awaiting_pr_approval; the write path is idempotent.
  creating_pr: ['completed', 'failed', 'awaiting_pr_approval'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  rejected: [],
  completed_without_pr: [],
};

/** States in which the orchestrator worker performs work. */
export const WORKER_STATES: readonly RunStatus[] = ['queued', 'retrieving_context', 'investigating', 'planning', 'preparing_workspace', 'implementing', 'verifying', 'reviewing', 'creating_pr'];
/** States waiting on a human. */
export const HUMAN_STATES: readonly RunStatus[] = ['awaiting_plan_approval', 'awaiting_pr_approval'];

export function isTerminal(s: RunStatus): boolean {
  return (RUN_TERMINAL_STATUSES as readonly string[]).includes(s);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Stage label shown in the UI for each status. */
export function stageOf(s: RunStatus): string | null {
  switch (s) {
    case 'retrieving_context':
      return 'context_retrieval';
    case 'investigating':
      return 'investigation';
    case 'planning':
    case 'awaiting_plan_approval':
      return 'planning';
    case 'preparing_workspace':
    case 'implementing':
      return 'implementation';
    case 'verifying':
      return 'verification';
    case 'reviewing':
    case 'awaiting_pr_approval':
      return 'review';
    case 'creating_pr':
      return 'pull_request';
    default:
      return null;
  }
}
