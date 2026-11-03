import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { canonicalJson, sha256Hex } from '../common/crypto.js';
import { Errors } from '../common/errors.js';
import { logger } from '../common/logger.js';
import { DatabaseService } from '../database/database.service.js';
import { GithubApiError, GithubAppService } from '../github/github-app.service.js';
import { RunEventsService } from '../runs/run-events.service.js';
import { RunTransitionsService } from '../runs/run-transitions.service.js';
import { runView } from '../runs/runs.service.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { AccessService } from '../workspaces/access.service.js';

const log = logger('review');
const OUTPUT_EXCERPT_BYTES = 8192;

function stringField(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}
const MAX_DIFF_BYTES = 1024 * 1024;

export const dispositionBody = z.object({ status: z.enum(['accepted', 'dismissed', 'fixed']), comment: z.string().max(2000).optional() }).strict();
export const prApprovalBody = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    comment: z.string().max(2000).optional(),
    /** Hash of the patch the human reviewed. Required to approve. */
    patch_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .refine((b) => b.decision === 'rejected' || b.patch_hash !== undefined, { message: 'patch_hash is required to approve', path: ['patch_hash'] });
export const pullRequestBody = z
  .object({
    title: z.string().trim().min(1).max(250),
    body: z.string().max(60_000).default(''),
    base_branch: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9._/-]+$/)
      .refine((b) => !b.includes('..'))
      .optional(),
  })
  .strict();

const patchFiles = z.array(z.object({ path: z.string(), action: z.string(), before: z.string().nullable(), after: z.string().nullable(), explanation: z.string().optional() }));

/**
 * Diff, verification and review read models; finding dispositions; human PR
 * approval bound to the reviewed patch hash; and PR creation (FR-VER-007,
 * FR-GIT-007). No PR is ever created without an approval for the exact patch,
 * and nothing is merged or deployed.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly storage: ObjectStorage,
    private readonly transitions: RunTransitionsService,
    private readonly events: RunEventsService,
    private readonly audit: AuditService,
    private readonly github: GithubAppService,
  ) {}

  private async currentPatch(runId: string) {
    return this.database.db.selectFrom('patches').selectAll().where('run_id', '=', runId).where('status', '=', 'applied').orderBy('attempt', 'desc').limit(1).executeTakeFirst();
  }

  async diff(userId: string, runId: string) {
    await this.access.requireRun(userId, runId);
    const patch = await this.currentPatch(runId);
    if (!patch) throw Errors.notFound('Patch');
    const files = patchFiles.parse(JSON.parse((await this.storage.get(patch.files_object_key ?? ''))?.toString('utf8') ?? '[]'));
    const diff = (await this.storage.get(patch.patch_object_key))?.toString('utf8') ?? '';
    const all = await this.database.db.selectFrom('patches').select(['id', 'attempt', 'status', 'patch_hash', 'created_at']).where('run_id', '=', runId).orderBy('attempt').execute();
    return {
      patch_id: patch.id,
      patch_hash: patch.patch_hash,
      attempt: patch.attempt,
      base_commit_sha: patch.base_commit_sha,
      summary: patch.summary,
      additions: patch.additions,
      deletions: patch.deletions,
      changed_files: files.map((f) => ({ path: f.path, action: f.action, explanation: f.explanation ?? null })),
      diff: diff.length > MAX_DIFF_BYTES ? diff.slice(0, MAX_DIFF_BYTES) : diff,
      diff_truncated: diff.length > MAX_DIFF_BYTES,
      attempts: all.map((a) => ({ ...a, created_at: a.created_at.toISOString() })),
    };
  }

  /** Deterministic results, reported separately as passed/failed/skipped/unavailable (FR-VER-005). */
  async verification(userId: string, runId: string) {
    const { run } = await this.access.requireRun(userId, runId);
    const rows = await this.database.db.selectFrom('verification_runs').selectAll().where('run_id', '=', runId).orderBy('created_at').execute();
    const excerpt = async (key: string | null) => {
      if (!key) return null;
      const b = await this.storage.get(key);
      if (!b) return null;
      const t = b.toString('utf8');
      return t.length > OUTPUT_EXCERPT_BYTES ? `…${t.slice(-OUTPUT_EXCERPT_BYTES)}` : t;
    };
    const results = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        patch_id: r.patch_id,
        attempt: r.attempt,
        profile_id: r.profile_id,
        command_display: r.command_display,
        image: r.image,
        status: r.status,
        exit_code: r.exit_code,
        duration_ms: r.duration_ms,
        output_truncated: r.output_truncated,
        // Heuristic test selection that narrowed this run (null = the full profile ran).
        test_selection: r.test_selection,
        stdout_excerpt: await excerpt(r.stdout_object_key),
        stderr_excerpt: await excerpt(r.stderr_object_key),
        created_at: r.created_at.toISOString(),
      })),
    );
    const latest = await this.currentPatch(runId);
    const current = results.filter((r) => r.patch_id === latest?.id);
    const count = (s: string) => current.filter((r) => r.status === s).length;
    // Unavailable = checks the repository needs but no profile can run, plus profiles the sandbox failed to run (infrastructure, not a test result).
    const declared = Array.isArray(run.checkpoint.unavailable_profiles) ? (run.checkpoint.unavailable_profiles as Array<{ profile_id: string; reason: string }>) : [];
    const unavailable = [
      ...declared.map((u) => ({ profile_id: u.profile_id, reason: u.reason, kind: 'unsupported' as const })),
      ...current.filter((r) => r.status === 'error').map((r) => ({ profile_id: r.profile_id, reason: 'The execution sandbox failed to run this profile (infrastructure error).', kind: 'sandbox_error' as const })),
    ];
    return {
      deterministic: true,
      current_patch_id: latest?.id ?? null,
      summary: { passed: count('passed'), failed: count('failed'), timed_out: count('timed_out'), skipped: count('skipped'), unavailable: unavailable.length },
      unavailable,
      results,
    };
  }

  /** AI findings are kept separate from deterministic scanner/test findings (FR-VER-004). */
  async review(userId: string, runId: string) {
    const { run } = await this.access.requireRun(userId, runId);
    const rows = await this.database.db.selectFrom('review_findings').selectAll().where('run_id', '=', runId).orderBy('created_at').limit(500).execute();
    const view = rows.map((f) => ({
      id: f.id,
      patch_id: f.patch_id,
      source: f.source,
      severity: f.severity,
      file_path: f.file_path,
      start_line: f.start_line,
      end_line: f.end_line,
      title: f.title,
      description: f.description,
      evidence: f.evidence,
      // AI_WORKFLOW §4.3; lifted out of `evidence` for clients. Null for deterministic findings.
      confidence: f.source === 'ai_review' ? (stringField(f.evidence, 'confidence') ?? null) : null,
      suggested_action: f.source === 'ai_review' ? (stringField(f.evidence, 'suggested_action') ?? null) : null,
      status: f.status,
      disposition_by: f.disposition_by,
      disposition_comment: f.disposition_comment,
      disposition_at: f.disposition_at?.toISOString() ?? null,
      created_at: f.created_at.toISOString(),
    }));
    return {
      summary: typeof run.checkpoint.review_summary === 'string' ? run.checkpoint.review_summary : null,
      deterministic_findings: view.filter((f) => f.source !== 'ai_review'),
      ai_findings: view.filter((f) => f.source === 'ai_review'),
    };
  }

  async disposition(userId: string, runId: string, findingId: string, body: z.infer<typeof dispositionBody>) {
    const { run } = await this.access.requireRun(userId, runId, 'member');
    const updated = await this.database.transaction(async (tx) => {
      const row = await tx
        .updateTable('review_findings')
        .set({ status: body.status, disposition_by: userId, disposition_comment: body.comment ?? null, disposition_at: new Date() })
        .where('id', '=', findingId)
        .where('run_id', '=', runId)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw Errors.notFound('Finding');
      await this.audit.record({ organizationId: run.organization_id, actorUserId: userId, action: 'finding.disposition', resourceType: 'review_finding', resourceId: findingId, metadata: { status: body.status, source: row.source, severity: row.severity } }, tx);
      return row;
    });
    return { id: updated.id, status: updated.status, disposition_by: updated.disposition_by, disposition_comment: updated.disposition_comment, disposition_at: updated.disposition_at?.toISOString() ?? null };
  }

  /** Human PR approval, bound to the exact reviewed patch hash. */
  async prApproval(userId: string, runId: string, body: z.infer<typeof prApprovalBody>) {
    await this.access.requireRun(userId, runId, 'member');
    const updated = await this.database.transaction(async (tx) => {
      const run = await tx.selectFrom('workflow_runs').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
      if (run.status !== 'awaiting_pr_approval') throw Errors.invalidState('This run is not awaiting pull-request approval.');
      const patch = await tx.selectFrom('patches').selectAll().where('run_id', '=', runId).where('status', '=', 'applied').orderBy('attempt', 'desc').limit(1).executeTakeFirstOrThrow();
      if (body.decision === 'approved' && body.patch_hash !== patch.patch_hash) {
        throw Errors.conflict('PATCH_CHANGED', 'The patch changed since you reviewed it.', { patch_hash: patch.patch_hash });
      }
      await tx.insertInto('approvals').values({ run_id: runId, user_id: userId, approval_type: 'pull_request', decision: body.decision, comment: body.comment ?? null, subject_hash: patch.patch_hash }).execute();
      await this.audit.record({ organizationId: run.organization_id, actorUserId: userId, action: `pull_request.${body.decision}`, resourceType: 'run', resourceId: runId, metadata: { patch_hash: patch.patch_hash } }, tx);
      if (body.decision === 'rejected') return this.transitions.transition(tx, run, 'completed_without_pr', { type: 'user', userId }, { reason: body.comment ?? 'pull request rejected' });
      return run;
    });
    await this.events.notify(runId);
    return { ...runView(updated), pr_approved: body.decision === 'approved' };
  }

  /**
   * Creates the PR. Verifies: actor role, repository still connected and
   * authorized, run state, a valid approval for the current patch hash newer
   * than the patch, the stored patch unchanged, no existing PR, and (in the
   * GitHub client) the installation's write permissions.
   */
  async createPullRequest(userId: string, runId: string, body: z.infer<typeof pullRequestBody>) {
    await this.access.requireRun(userId, runId, 'member');
    const prepared = await this.database.transaction(async (tx) => {
      const run = await tx.selectFrom('workflow_runs').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
      const existing = await tx.selectFrom('pull_requests').selectAll().where('run_id', '=', runId).executeTakeFirst();
      if (existing) throw Errors.conflict('PULL_REQUEST_EXISTS', 'A pull request was already created for this run.', { pr_url: existing.pr_url });
      if (run.status !== 'awaiting_pr_approval') throw Errors.invalidState('This run is not awaiting pull-request creation.');
      const patch = await tx.selectFrom('patches').selectAll().where('run_id', '=', runId).where('status', '=', 'applied').orderBy('attempt', 'desc').limit(1).executeTakeFirstOrThrow();
      const approval = await tx
        .selectFrom('approvals')
        .selectAll()
        .where('run_id', '=', runId)
        .where('approval_type', '=', 'pull_request')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!approval || approval.decision !== 'approved' || approval.subject_hash !== patch.patch_hash || approval.created_at < patch.created_at) {
        throw Errors.forbidden('Pull-request creation requires a human approval of the current patch.');
      }
      const repo = await tx
        .selectFrom('repositories as r')
        .leftJoin('git_installations as i', 'i.id', 'r.installation_id')
        .select(['r.id', 'r.status', 'r.full_name', 'r.external_repository_id', 'r.default_branch', 'i.external_installation_id', 'i.status as installation_status'])
        .where('r.id', '=', run.repository_id)
        .where('r.organization_id', '=', run.organization_id)
        .executeTakeFirstOrThrow();
      if (repo.status !== 'connected') throw Errors.invalidState('The repository is not connected.');
      if (!repo.external_installation_id || repo.installation_status !== 'active') {
        throw Errors.unprocessable('PULL_REQUEST_NOT_SUPPORTED', 'This repository is not connected through an active GitHub installation.');
      }
      const next = await this.transitions.transition(tx, run, 'creating_pr', { type: 'user', userId }, { reason: 'pull request creation requested' });
      return { run: next, patch, approval, repo };
    });
    await this.events.notify(runId);

    const { run, patch, approval, repo } = prepared;
    try {
      // The stored patch must be exactly the approved patch.
      const raw = await this.storage.get(patch.files_object_key ?? '');
      const files = patchFiles.parse(JSON.parse(raw?.toString('utf8') ?? '[]'));
      const recomputed = `sha256:${sha256Hex(canonicalJson(files.map((f) => ({ path: f.path, action: f.action, after: f.after }))))}`;
      if (recomputed !== approval.subject_hash) throw Errors.conflict('PATCH_INTEGRITY_FAILED', 'The stored patch does not match the approved patch.');
      const verification = await this.database.db.selectFrom('verification_runs').select(['profile_id', 'status', 'exit_code']).where('patch_id', '=', patch.id).execute();
      const findings = await this.database.db.selectFrom('review_findings').select(['source', 'severity', 'status']).where('patch_id', '=', patch.id).execute();
      const approver = await this.database.db.selectFrom('users').select(['email', 'display_name']).where('id', '=', approval.user_id).executeTakeFirstOrThrow();
      const evidence = [
        '',
        '---',
        '### Verification (deterministic)',
        ...(verification.length ? verification.map((v) => `- \`${v.profile_id}\`: **${v.status}**${v.exit_code !== null ? ` (exit ${v.exit_code})` : ''}`) : ['- No verification profile ran.']),
        '### Review findings',
        `- Deterministic: ${findings.filter((f) => f.source !== 'ai_review').length} · AI review: ${findings.filter((f) => f.source === 'ai_review').length} (AI findings are advisory)`,
        '',
        `Patch \`${patch.patch_hash.slice(0, 19)}\` · base \`${patch.base_commit_sha.slice(0, 12)}\` · approved by ${approver.display_name ?? approver.email}. Generated with Anvaya; human review required before merging.`,
      ].join('\n');
      const pr = await this.github.createPullRequest({
        installationId: repo.external_installation_id!,
        repositoryId: repo.external_repository_id,
        fullName: repo.full_name,
        baseCommitSha: patch.base_commit_sha,
        baseBranch: body.base_branch ?? run.base_branch ?? repo.default_branch ?? 'main',
        headBranch: `anvaya/run-${run.id.slice(0, 8)}-${run.run_number}`,
        title: body.title,
        body: `${body.body}${evidence}`.slice(0, 65_000),
        commitMessage: `${body.title}\n\nAnvaya run ${run.id} · patch ${patch.patch_hash}`,
        changes: files.map((f) => ({ path: f.path, content: f.after })),
      });
      const done = await this.database.transaction(async (tx) => {
        const current = await tx.selectFrom('workflow_runs').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
        const row = await tx
          .insertInto('pull_requests')
          .values({ run_id: runId, provider: 'github', external_pr_id: pr.id, pr_number: pr.number, pr_url: pr.url, head_branch: pr.headBranch, base_branch: body.base_branch ?? run.base_branch ?? repo.default_branch ?? 'main' })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.events.emit(tx, current, 'pull_request.created', { pr_number: pr.number, pr_url: pr.url, head_branch: pr.headBranch });
        await this.audit.record({ organizationId: run.organization_id, actorUserId: userId, action: 'pull_request.created', resourceType: 'run', resourceId: runId, metadata: { pr_number: pr.number, pr_url: pr.url, patch_hash: patch.patch_hash } }, tx);
        await this.transitions.transition(tx, current, 'completed', { type: 'user', userId }, { reason: `pull request #${pr.number} created` });
        return row;
      });
      await this.events.notify(runId);
      return { id: done.id, run_id: runId, provider: 'github', pr_number: done.pr_number, pr_url: done.pr_url, head_branch: done.head_branch, base_branch: done.base_branch, created_at: done.created_at.toISOString() };
    } catch (err) {
      const retryable = err instanceof GithubApiError ? err.transient : false;
      log.warn({ run_id: runId, err: (err as Error).message, retryable }, 'pull request creation failed');
      await this.database.transaction(async (tx) => {
        const current = await tx.selectFrom('workflow_runs').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
        if (current.status !== 'creating_pr') return;
        if (retryable) await this.transitions.transition(tx, current, 'awaiting_pr_approval', { type: 'system' }, { reason: 'pull request creation failed transiently; retry is possible' });
        else await this.transitions.transition(tx, current, 'failed', { type: 'system' }, { reason: 'pull request creation failed', errorCode: 'PULL_REQUEST_FAILED', errorSummary: (err as Error).message.slice(0, 300) });
      });
      await this.events.notify(runId);
      if (err instanceof GithubApiError) {
        if (err.status === 403) throw Errors.forbidden('The GitHub App installation does not grant permission to create pull requests.');
        throw retryable ? Errors.unavailable('GITHUB_UNAVAILABLE', 'GitHub is unavailable; you can retry.') : Errors.upstream('PULL_REQUEST_FAILED', 'GitHub rejected the pull request.');
      }
      throw err;
    }
  }
}
