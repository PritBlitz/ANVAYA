import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { logger } from '../common/logger.js';
import { boundText, redactText } from '../common/redact.js';
import { AppConfig } from '../config/config.js';
import { json, type JsonObject, type WorkflowRun } from '../database/types.js';
import { findSecrets } from '../indexing/classifier.js';
import { RepositorySource, type SourceRepository } from '../indexing/sources.js';
import { effectiveSettings } from '../repositories/repositories.service.js';
import { ExecutionStages } from '../runs/orchestrator.service.js';
import { planSchema } from '../runs/run.schemas.js';
import { filterProfilesByTemplate, isPlanOnly, parseSnapshot } from '../templates/templates.js';
import { RunNoLongerActive, StageFailure, StageToolkit } from '../runs/stage-toolkit.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { PatchRejected, composePatch, patchProposalSchema, removedCode, validatePatch, type ValidatedPatch } from './patch-validator.js';
import { profileById, selectProfiles, unavailableChecks, type VerificationProfile } from './profiles.js';
import { SandboxDriver, type SandboxResult } from './sandbox.js';
import { WorkspaceManager } from './workspace.js';
import { ImpactService } from '../intelligence/impact.service.js';
import { isTestFile } from '../intelligence/graph.js';
import { normalizePath } from '../indexing/classifier.js';

const log = logger('execution');
const MAX_CONTEXT_FILE_BYTES = 64 * 1024;
const MAX_REVIEW_DIFF_BYTES = 60 * 1024;
const MAX_REMOVED_LINES_SHOWN = 5;
const FAILURE_TAIL_BYTES = 4096;

const reviewOutput = z.object({
  summary: z.string().max(4000),
  findings: z
    .array(
      z.object({
        severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
        file_path: z.string().max(500),
        start_line: z.number().int().min(1),
        end_line: z.number().int().min(1),
        title: z.string().max(500),
        rationale: z.string().max(4000),
        evidence: z.array(z.string().max(500)).max(6).default([]),
        confidence: z.enum(['low', 'medium', 'high']),
        suggested_action: z.string().max(500).nullable().optional(),
      }),
    )
    .max(20),
});

interface Failure {
  kind: 'verification' | 'patch_validation' | 'security';
  detail: string;
}

/**
 * Post-approval stages (AI_WORKFLOW §3): isolated workspace → patch developer →
 * patch validation → sandboxed deterministic verification → bounded repair →
 * review + deterministic security checks → human PR approval.
 *
 * Pass/fail comes only from sandbox exit codes; models can summarise but never
 * set verification status. All repository code runs only inside the sandbox.
 */
@Injectable()
export class ExecutionPipeline extends ExecutionStages {
  constructor(
    private readonly kit: StageToolkit,
    private readonly source: RepositorySource,
    private readonly workspaces: WorkspaceManager,
    private readonly sandbox: SandboxDriver,
    private readonly storage: ObjectStorage,
    private readonly config: AppConfig,
    private readonly impact: ImpactService,
  ) {
    super();
  }

  /**
   * Heuristic test selection for 'narrow' repositories: the impact prediction's selected test
   * files that exist in the workspace. Returns null when selection is off or selects nothing,
   * in which case every profile runs in full. The deterministic exit code still decides the result.
   */
  private async testSelection(run: WorkflowRun, paths: readonly string[]): Promise<{ files: string[]; reasons: Record<string, string>; testFilesTotal: number } | null> {
    const repo = await this.kit.database.db.selectFrom('repositories').select('settings').where('id', '=', run.repository_id).executeTakeFirstOrThrow();
    if (effectiveSettings(repo.settings).test_selection !== 'narrow' || !run.snapshot_id) return null;
    const changes = await this.impact.runChanges(run);
    if (changes.changed.length === 0) return null;
    const result = await this.impact.predict(run.snapshot_id, changes.changed, 50);
    const inWorkspace = new Set(paths);
    const selected = result.selected_tests.filter((t) => inWorkspace.has(t.path) && normalizePath(t.path) === t.path && !t.path.startsWith('-'));
    if (selected.length === 0) return null;
    return {
      files: selected.map((t) => t.path),
      reasons: Object.fromEntries(selected.map((t) => [t.path, t.reasons[0]?.description ?? 'selected'])),
      testFilesTotal: paths.filter(isTestFile).length,
    };
  }

  async advance(run: WorkflowRun): Promise<'progressed' | 'waiting'> {
    switch (run.status) {
      case 'preparing_workspace':
        await this.prepare(run);
        return 'progressed';
      case 'implementing':
        await this.implement(run);
        return 'progressed';
      case 'verifying':
        await this.verify(run);
        return 'progressed';
      case 'reviewing':
        await this.review(run);
        return 'progressed';
      default:
        // creating_pr is executed by the API under an explicit human approval.
        return 'waiting';
    }
  }

  async release(runId: string): Promise<void> {
    await this.workspaces.cleanup(runId).catch((err: unknown) => log.warn({ run_id: runId, err: (err as Error).message }, 'workspace cleanup failed'));
  }

  // ---------------------------------------------------------------------------
  private async repository(run: WorkflowRun): Promise<SourceRepository> {
    const repo = await this.kit.database.db
      .selectFrom('repositories as r')
      .leftJoin('git_installations as i', 'i.id', 'r.installation_id')
      .selectAll('r')
      .select(['i.external_installation_id', 'i.status as installation_status'])
      .where('r.id', '=', run.repository_id)
      .where('r.organization_id', '=', run.organization_id)
      .executeTakeFirstOrThrow();
    if (repo.status !== 'connected') throw new StageFailure('REPOSITORY_NOT_CONNECTED', 'The repository is no longer connected.');
    if (this.config.env.REPOSITORY_SOURCE === 'github' && repo.installation_status !== 'active') throw new StageFailure('INSTALLATION_INACTIVE', 'The GitHub installation is not active.');
    return repo;
  }

  private async approvedPlan(run: WorkflowRun) {
    const hash = run.checkpoint.approved_plan_hash;
    if (typeof hash !== 'string') throw new StageFailure('PLAN_NOT_APPROVED', 'No approved plan is recorded for this run.');
    const row = await this.kit.database.db.selectFrom('run_plans').select(['content', 'content_hash']).where('run_id', '=', run.id).where('content_hash', '=', hash).executeTakeFirst();
    const plan = planSchema.safeParse(row?.content);
    if (!row || !plan.success) throw new StageFailure('PLAN_NOT_APPROVED', 'The approved plan could not be loaded.');
    return plan.data;
  }

  /** (Re)creates the workspace at the snapshot commit and re-applies the current patch, if any. */
  private async ensureWorkspace(run: WorkflowRun): Promise<string[]> {
    if (await this.workspaces.exists(run.id)) return (run.checkpoint.workspace_paths as string[] | undefined) ?? [];
    const repo = await this.repository(run);
    const commit = typeof run.checkpoint.commit_sha === 'string' ? run.checkpoint.commit_sha : null;
    if (!commit) throw new StageFailure('SNAPSHOT_MISSING', 'The run has no commit to build a workspace from.');
    const settings = effectiveSettings(repo.settings);
    const snapshot = await this.source.fetch(repo, commit, { maxArchiveBytes: 300 * 1024 * 1024, maxFiles: 20_000, maxFileBytes: Math.max(settings.max_file_bytes, 1024 * 1024) });
    const res = await this.workspaces.materialize(run.id, snapshot.files);
    const patchId = run.checkpoint.current_patch_id;
    if (typeof patchId === 'string') {
      const files = await this.loadPatchFiles(patchId);
      for (const f of files) {
        if (f.after === null) await this.workspaces.remove(run.id, f.path);
        else await this.workspaces.writeText(run.id, f.path, f.after);
      }
    }
    return res.paths;
  }

  // ---------------------------------------------------------------------------
  // preparing_workspace
  // ---------------------------------------------------------------------------
  private async prepare(run: WorkflowRun): Promise<void> {
    // Defence in depth: plan-only runs end at plan approval and must never get a workspace.
    if (isPlanOnly(run)) throw new StageFailure('PLAN_ONLY_WORKFLOW', 'This run is plan-only; nothing is executed.');
    await this.approvedPlan(run);
    const stepId = await this.kit.startStep(run, 'workspace', { commit_sha: run.checkpoint.commit_sha ?? null });
    const toolId = await this.kit.startTool(run, stepId, 'prepare_workspace', { commit_sha: run.checkpoint.commit_sha ?? null });
    const started = Date.now();
    await this.workspaces.cleanup(run.id);
    const paths = await this.ensureWorkspace({ ...run, checkpoint: { ...run.checkpoint, current_patch_id: null } });
    const repo = await this.repository(run);
    const dependencyFetch = this.config.env.SANDBOX_DEPENDENCY_FETCH === 'enabled';
    // The task's template may restrict which server-defined profiles run; excluded ones are reported, never hidden.
    const template = parseSnapshot((await this.kit.task(run)).template);
    const byTemplate = filterProfilesByTemplate(selectProfiles(effectiveSettings(repo.settings).verification_profiles, new Set(paths), { dependencyFetch }), template);
    const profiles = byTemplate.allowed;
    const unavailable = [...unavailableChecks(new Set(paths), { dependencyFetch }), ...byTemplate.excluded];
    await this.kit.database.transaction(async (tx) => {
      const current = await this.kit.guard(tx, run);
      await this.kit.finishTool(tx, current, toolId, 'succeeded', { files: paths.length, profiles: profiles.map((p) => p.id) }, Date.now() - started, 'prepare_workspace');
      await this.kit.finishStep(tx, stepId, 'succeeded', { files: paths.length, profiles: profiles.map((p) => p.id) }, null);
      await this.kit.transitions.transition(tx, current, 'implementing', { type: 'worker' }, {
        reason: `workspace prepared (${paths.length} files)`,
        checkpointPatch: { workspace_paths: paths, profiles: profiles.map((p) => p.id), unavailable_profiles: json(unavailable), repair_attempts: 0, patch_attempt: 0, last_failure: null, current_patch_id: null },
      });
    });
    await this.kit.events.notify(run.id);
  }

  // ---------------------------------------------------------------------------
  // implementing (Patch Developer / Repair assistant)
  // ---------------------------------------------------------------------------
  private async implement(run: WorkflowRun): Promise<void> {
    const plan = await this.approvedPlan(run);
    const budget = this.kit.budget(run);
    await this.ensureWorkspace(run);
    const files: Array<{ path: string; content: string }> = [];
    for (const path of plan.files_to_modify) {
      const content = await this.workspaces.readText(run.id, path);
      if (content !== null && Buffer.byteLength(content) <= MAX_CONTEXT_FILE_BYTES) files.push({ path, content });
    }
    const lastFailure = (run.checkpoint.last_failure ?? null) as Failure | null;
    const isRepair = lastFailure !== null;
    const task = await this.kit.task(run);
    const gen = await this.kit.callModel(run, isRepair ? 'repair_assistant' : 'patch_developer', {
      task: isRepair ? 'repair' : 'patch',
      intent: this.kit.intent(task),
      untrusted_inputs: [...this.kit.untrusted(task), ...(isRepair ? [{ label: 'verification_failure', content: lastFailure.detail }] : [])],
      evidence: [],
      context: { approved_plan: plan, files, max_changed_files: budget.max_changed_files, files_missing: plan.files_to_modify.filter((p) => !files.some((f) => f.path === p)) },
    });

    const parsed = patchProposalSchema.safeParse(gen.output);
    let validated: ValidatedPatch | null = null;
    let rejection: PatchRejected | null = null;
    if (!parsed.success) {
      rejection = new PatchRejected('PATCH_INVALID', 'The patch output did not match the patch schema.');
    } else {
      const current = new Map<string, string | null>();
      for (const c of parsed.data.changes) current.set(c.path, await this.workspaces.readText(run.id, c.path).catch(() => null));
      try {
        validated = validatePatch(parsed.data, { allowedFiles: plan.files_to_modify, maxChangedFiles: budget.max_changed_files, current: (p) => current.get(p) ?? null });
        // A repair is validated against the workspace with the earlier patch applied; store it
        // cumulatively against the base commit, or the pull request would carry only the delta.
        const priorPatchId = typeof run.checkpoint.current_patch_id === 'string' ? run.checkpoint.current_patch_id : null;
        if (priorPatchId) {
          const prior = await this.loadPatchFiles(priorPatchId);
          if (prior.length === 0) throw new StageFailure('PATCH_MISSING', 'The patch being repaired could not be loaded.');
          validated = composePatch(prior, validated, budget.max_changed_files);
        }
      } catch (err) {
        if (!(err instanceof PatchRejected)) throw err;
        rejection = err;
      }
    }

    const attempt = Number(run.checkpoint.patch_attempt ?? 0) + 1;
    if (!validated) {
      const r = rejection!;
      await this.kit.database.transaction(async (tx) => {
        const current = await this.kit.guard(tx, run);
        await this.kit.completeModelStep(tx, current, gen, { rejected: true, code: r.code, problems: r.details }, 'failed', r.code);
      });
      if (r.code === 'PLAN_REVISION_REQUIRED') throw new StageFailure('PLAN_REVISION_REQUIRED', 'The developer stage requested a plan revision. Start a new run with an updated plan.');
      await this.scheduleRepairOrFail(run, { kind: 'patch_validation', detail: `${r.message} ${r.details.join('; ')}`.slice(0, FAILURE_TAIL_BYTES) }, 'PATCH_REJECTED', r.message);
      return;
    }

    // Apply in the disposable workspace (never on the application host's repository).
    for (const c of validated.changes) {
      if (c.after === null) await this.workspaces.remove(run.id, c.path);
      else await this.workspaces.writeText(run.id, c.path, c.after);
    }
    const base = `runs/${run.id}/patches/${attempt}`;
    await this.storage.put(`${base}.diff`, validated.diff);
    await this.storage.put(`${base}.json`, JSON.stringify(validated.changes.map((c) => ({ path: c.path, action: c.action, before: c.before, after: c.after, explanation: c.explanation }))));
    const commit = typeof run.checkpoint.commit_sha === 'string' ? run.checkpoint.commit_sha : '';
    await this.kit.database.transaction(async (tx) => {
      const current = await this.kit.guard(tx, run);
      await this.kit.completeModelStep(tx, current, gen, { summary: validated.summary, files: validated.changes.map((c) => ({ path: c.path, action: c.action, additions: c.additions, deletions: c.deletions })) });
      const patch = await tx
        .insertInto('patches')
        .values({
          run_id: run.id,
          patch_object_key: `${base}.diff`,
          files_object_key: `${base}.json`,
          patch_hash: validated.hash,
          base_commit_sha: commit,
          changed_files: validated.changes.length,
          additions: validated.additions,
          deletions: validated.deletions,
          status: 'applied',
          attempt,
          summary: validated.summary,
          validation: json({ allowed_files: plan.files_to_modify, max_changed_files: budget.max_changed_files, passed: true }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.updateTable('patches').set({ status: 'rejected' }).where('run_id', '=', run.id).where('id', '!=', patch.id).where('status', '=', 'applied').execute();
      await this.kit.events.emit(tx, current, 'patch.proposed', { patch_id: patch.id, patch_hash: validated.hash, attempt, changed_files: validated.changes.length, additions: validated.additions, deletions: validated.deletions });
      await this.kit.transitions.transition(tx, current, 'verifying', { type: 'worker' }, {
        reason: `patch ${attempt} applied (${validated.changes.length} file(s))`,
        checkpointPatch: { current_patch_id: patch.id, current_patch_hash: validated.hash, patch_attempt: attempt, last_failure: null },
      });
    });
    await this.kit.events.notify(run.id);
  }

  // ---------------------------------------------------------------------------
  // verifying (deterministic)
  // ---------------------------------------------------------------------------
  private async verify(run: WorkflowRun): Promise<void> {
    await this.ensureWorkspace(run);
    const profileIds = (run.checkpoint.profiles as string[] | undefined) ?? [];
    const patchId = typeof run.checkpoint.current_patch_id === 'string' ? run.checkpoint.current_patch_id : null;
    const attempt = Number(run.checkpoint.patch_attempt ?? 1);
    const stepId = await this.kit.startStep(run, 'verification_engine', { profiles: profileIds, patch_id: patchId });
    const selection = profileIds.some((id) => profileById(id)?.testSelection) ? await this.testSelection(run, (run.checkpoint.workspace_paths as string[] | undefined) ?? []) : null;
    const results: Array<{ profile: string; status: 'passed' | 'failed' | 'timed_out' | 'skipped' | 'error'; exit_code: number | null; stderr: string; stdout: string }> = [];

    if (profileIds.length === 0) {
      await this.kit.database.transaction(async (tx) => {
        const current = await this.kit.guard(tx, run);
        await tx.insertInto('verification_runs').values({ run_id: run.id, patch_id: patchId, attempt, profile_id: 'none', command_display: 'No applicable verification profile for this repository', status: 'skipped' }).execute();
        await this.kit.events.emit(tx, current, 'verification.completed', { profile: 'none', status: 'skipped', exit_code: null });
      });
      results.push({ profile: 'none', status: 'skipped', exit_code: null, stderr: '', stdout: '' });
    }

    for (const id of profileIds) {
      const base = profileById(id);
      if (!base) continue;
      // Narrow a selection-capable profile to the heuristically selected tests it can run.
      const narrowed = base.testSelection && selection ? selection.files.filter((f) => base.testSelection!.pattern.test(f)) : [];
      const testSelection = narrowed.length
        ? { mode: 'narrow', heuristic: true, files: narrowed, reasons: Object.fromEntries(narrowed.map((f) => [f, selection!.reasons[f] ?? 'selected'])), test_files_total: selection!.testFilesTotal, not_run: Math.max(0, selection!.testFilesTotal - narrowed.length) }
        : null;
      const profile: VerificationProfile = testSelection
        ? { ...base, argv: base.testSelection!.argv(narrowed), commandDisplay: `${base.commandDisplay} (heuristic test selection: ${narrowed.length} of ${testSelection.test_files_total} test files)` }
        : base;
      const remaining = await this.kit.remainingSeconds(run);
      if (remaining < 5) throw new StageFailure('BUDGET_EXHAUSTED', 'No time budget left for verification.');
      const toolId = await this.kit.startTool(run, stepId, 'run_profile', { profile_id: profile.id });
      await this.kit.database.transaction(async (tx) => {
        await this.kit.events.emit(tx, run, 'sandbox.started', { profile: profile.id, command: profile.commandDisplay });
      });
      await this.kit.events.notify(run.id);
      // Cancellation propagates to the sandbox (docker kill).
      const abort = new AbortController();
      const watcher = setInterval(() => {
        this.kit.assertActive(run.id).catch(() => abort.abort());
      }, 2000);
      let res: SandboxResult | undefined;
      let deps: Awaited<ReturnType<ExecutionPipeline['installDependencies']>> | null = null;
      try {
        if (profile.dependencies) deps = await this.installDependencies(run, profile, remaining, abort.signal);
        if (!deps || deps.ok) {
          res = await this.sandbox.run(profile, this.workspaces.dir(run.id), {
            timeoutSeconds: Math.max(5, Math.min(this.config.env.SANDBOX_TIMEOUT_SECONDS, Math.floor(remaining))),
            signal: abort.signal,
            ...(deps?.ok ? { dependencies: { spec: profile.dependencies!, dir: join(deps.dir, profile.dependencies!.runSubdir) } } : {}),
          });
        }
      } finally {
        clearInterval(watcher);
      }
      if (abort.signal.aborted) throw new RunNoLongerActive();
      if (deps && !deps.ok) {
        // Not run: reported as skipped with the reason, never as passed (FR-VER-005).
        const key = `runs/${run.id}/verification/${attempt}-${profile.id}`;
        await this.storage.put(`${key}.stderr`, `[anvaya] ${deps.reason}`);
        await this.kit.database.transaction(async (tx) => {
          const current = await this.kit.guard(tx, run);
          await tx
            .insertInto('verification_runs')
            .values({ run_id: run.id, patch_id: patchId, attempt, profile_id: profile.id, command_display: profile.commandDisplay, image: profile.image, status: 'skipped', stderr_object_key: `${key}.stderr` })
            .execute();
          await this.kit.finishTool(tx, current, toolId, 'failed', { profile_id: profile.id, status: 'skipped', reason: deps.reason }, 0, 'run_profile');
          await this.kit.events.emit(tx, current, 'verification.completed', { profile: profile.id, status: 'skipped', exit_code: null, attempt, reason: deps.reason });
        });
        await this.kit.events.notify(run.id);
        results.push({ profile: profile.id, status: 'skipped', exit_code: null, stderr: deps.reason, stdout: '' });
        continue;
      }
      if (!res) throw new Error('unreachable: profile did not run');
      const status = res.error ? 'error' : res.timedOut ? 'timed_out' : res.exitCode === 0 ? 'passed' : 'failed';
      const key = `runs/${run.id}/verification/${attempt}-${profile.id}`;
      await this.storage.put(`${key}.stdout`, res.stdout);
      await this.storage.put(`${key}.stderr`, res.stderr + (res.error ? `\n[anvaya] ${res.error}` : ''));
      await this.kit.database.transaction(async (tx) => {
        const current = await this.kit.guard(tx, run);
        await tx
          .insertInto('verification_runs')
          .values({
            run_id: run.id,
            patch_id: patchId,
            attempt,
            profile_id: profile.id,
            command_display: profile.commandDisplay,
            image: profile.image,
            status,
            exit_code: res.exitCode,
            duration_ms: res.durationMs,
            stdout_object_key: `${key}.stdout`,
            stderr_object_key: `${key}.stderr`,
            output_truncated: res.truncated,
            test_selection: testSelection ? json(testSelection) : null,
          })
          .execute();
        await this.kit.finishTool(tx, current, toolId, status === 'passed' ? 'succeeded' : 'failed', { profile_id: profile.id, status, exit_code: res.exitCode, duration_ms: res.durationMs }, res.durationMs, 'run_profile');
        await this.kit.events.emit(tx, current, 'verification.completed', { profile: profile.id, status, exit_code: res.exitCode, duration_ms: res.durationMs, attempt });
      });
      await this.kit.events.notify(run.id);
      results.push({ profile: profile.id, status, exit_code: res.exitCode, stderr: res.stderr, stdout: res.stdout });
      if (status === 'error') break;
    }

    const infra = results.find((r) => r.status === 'error');
    const failed = results.filter((r) => r.status === 'failed' || r.status === 'timed_out');
    await this.kit.database.transaction(async (tx) => {
      await this.kit.finishStep(tx, stepId, failed.length === 0 && !infra ? 'succeeded' : 'failed', { results: results.map(({ profile, status, exit_code }) => ({ profile, status, exit_code })) }, infra ? 'SANDBOX_ERROR' : failed.length ? 'VERIFICATION_FAILED' : null);
    });
    if (infra) throw new StageFailure('SANDBOX_ERROR', 'The execution sandbox failed to run a verification profile. This is an infrastructure problem, not a test failure.');
    if (failed.length > 0) {
      const detail = failed
        .map((f) => `profile ${f.profile}: ${f.status} (exit ${f.exit_code ?? 'n/a'})\n${boundText(redactText(f.stderr || f.stdout).slice(-FAILURE_TAIL_BYTES), FAILURE_TAIL_BYTES).text}`)
        .join('\n\n');
      await this.scheduleRepairOrFail(run, { kind: 'verification', detail }, 'VERIFICATION_FAILED', `Verification failed: ${failed.map((f) => f.profile).join(', ')}.`);
      return;
    }
    await this.kit.move(run, 'reviewing', results.every((r) => r.status === 'skipped') ? 'no verification profile applies; proceeding to review' : 'all verification profiles passed');
  }

  /**
   * B-4: validates the manifests on the host, then downloads dependencies in a networked
   * fetch container that never runs repository code. Cached per run and manifest hash, so a
   * repair attempt that does not touch the manifests reuses the download.
   */
  private async installDependencies(run: WorkflowRun, profile: VerificationProfile, remaining: number, signal: AbortSignal): Promise<{ ok: true; dir: string } | { ok: false; reason: string }> {
    const spec = profile.dependencies!;
    const workspaceDir = this.workspaces.dir(run.id);
    const prepared = await spec.prepare(workspaceDir);
    if (!prepared.ok) return { ok: false, reason: `Dependencies were not installed: ${prepared.reason}` };
    const hash = createHash('sha256');
    for (const f of prepared.stage) hash.update(f).update('\0').update(await readFile(join(workspaceDir, f)));
    const digest = hash.digest('hex');
    const dir = resolve(workspaceDir, '..', 'deps', spec.ecosystem);
    const marker = join(dir, '.anvaya-installed');
    if ((await readFile(marker, 'utf8').catch(() => '')) === digest) return { ok: true, dir };

    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o777 });
    await chmod(dir, 0o777);
    for (const f of prepared.stage) await copyFile(join(workspaceDir, f), join(dir, f));
    const toolStarted = Date.now();
    const timeoutSeconds = Math.max(10, Math.min(this.config.env.SANDBOX_FETCH_TIMEOUT_SECONDS, Math.floor(remaining)));
    const res = await this.sandbox.fetch(spec, prepared.stage, workspaceDir, dir, { timeoutSeconds, signal });
    const ok = !res.error && !res.timedOut && res.exitCode === 0;
    log.info({ run_id: run.id, ecosystem: spec.ecosystem, exit_code: res.exitCode, timed_out: res.timedOut, duration_ms: Date.now() - toolStarted }, 'dependency fetch finished');
    await this.kit.database.transaction(async (tx) => {
      const current = await this.kit.guard(tx, run);
      await this.kit.events.emit(tx, current, 'dependencies.installed', { profile: profile.id, ecosystem: spec.ecosystem, status: ok ? 'succeeded' : 'failed', duration_ms: res.durationMs });
    });
    if (!ok) {
      const tail = boundText(redactText(res.error ?? (res.stderr || res.stdout)).slice(-1500), 1500).text;
      return { ok: false, reason: `Dependency installation failed (${res.timedOut ? 'timed out' : `exit ${res.exitCode ?? 'n/a'}`}): ${tail}` };
    }
    await writeFile(marker, digest);
    return { ok: true, dir };
  }

  // ---------------------------------------------------------------------------
  // reviewing (AI reviewer + deterministic security checks)
  // ---------------------------------------------------------------------------
  private async review(run: WorkflowRun): Promise<void> {
    const patchId = typeof run.checkpoint.current_patch_id === 'string' ? run.checkpoint.current_patch_id : '';
    const patch = await this.kit.database.db.selectFrom('patches').selectAll().where('id', '=', patchId).where('run_id', '=', run.id).executeTakeFirst();
    if (!patch) throw new StageFailure('PATCH_MISSING', 'No applied patch to review.');
    const files = await this.loadPatchFiles(patch.id);
    const diff = (await this.storage.get(patch.patch_object_key))?.toString('utf8') ?? '';
    const plan = await this.approvedPlan(run);

    // Deterministic checks first: these are the security boundary, not the model.
    const scanner: Array<{ severity: 'high' | 'critical'; file: string; line: number; title: string; description: string }> = [];
    for (const f of files) {
      if (f.after === null) continue;
      const beforeSecrets = new Set(findSecrets(f.before ?? '').map((s) => s.kind));
      for (const s of findSecrets(f.after)) {
        if (!beforeSecrets.has(s.kind)) scanner.push({ severity: 'critical', file: f.path, line: s.line, title: `Possible ${s.kind.replace(/_/g, ' ')} added`, description: 'The change introduces content matching a credential pattern. The value is not recorded.' });
      }
    }

    // Not a blocker: removing code can be the task. The reviewer decides, but must be told.
    const removals = files.flatMap((f) => {
      const lines = f.before === null || f.after === null ? [] : removedCode(f.before, f.after);
      if (lines.length === 0) return [];
      const shown = lines.slice(0, MAX_REMOVED_LINES_SHOWN).map((l) => redactText(l.text).slice(0, 200));
      const more = lines.length - shown.length;
      const description = `Check these were meant to go. Tests can still pass when nothing covers them:\n${shown.join('\n')}${more > 0 ? `\n…and ${more} more` : ''}`;
      return [{ file: f.path, line: lines[0]!.line, title: `Existing code removed from ${f.path}`.slice(0, 200), description }];
    });

    const verification = await this.kit.database.db.selectFrom('verification_runs').select(['profile_id', 'status', 'exit_code']).where('patch_id', '=', patch.id).execute();
    const task = await this.kit.task(run);
    const gen = await this.kit.callModel(run, 'code_reviewer', {
      task: 'review',
      intent: this.kit.intent(task),
      untrusted_inputs: [{ label: 'diff', content: boundText(diff, MAX_REVIEW_DIFF_BYTES).text }],
      evidence: [],
      context: { approved_plan: plan, changed_files: files.map((f) => f.path), verification: verification.map((v) => ({ profile: v.profile_id, status: v.status, exit_code: v.exit_code })) },
    });
    const parsed = reviewOutput.safeParse(gen.output);
    if (!parsed.success) throw new StageFailure('INVALID_MODEL_OUTPUT', 'The review output failed validation.');
    const lineCount = new Map(files.map((f) => [f.path, (f.after ?? '').split('\n').length]));
    // AI findings must reference changed files and valid lines; others are dropped.
    const aiFindings = parsed.data.findings.filter((f) => lineCount.has(f.file_path) && f.start_line <= f.end_line && f.end_line <= (lineCount.get(f.file_path) ?? 0) + 1);

    const blocking = scanner.length > 0;
    await this.kit.database.transaction(async (tx) => {
      const current = await this.kit.guard(tx, run);
      await this.kit.completeModelStep(tx, current, gen, { summary: parsed.data.summary, findings: aiFindings.length, dropped: parsed.data.findings.length - aiFindings.length, scanner_findings: scanner.length });
      for (const s of scanner) {
        const row = await tx
          .insertInto('review_findings')
          .values({ run_id: run.id, patch_id: patch.id, source: 'security_scanner', severity: s.severity, file_path: s.file, start_line: s.line, end_line: s.line, title: s.title, description: s.description, evidence: json({ scanner: 'anvaya-secret-patterns', deterministic: true }) })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.kit.events.emit(tx, current, 'review.finding.created', { finding_id: row.id, source: 'security_scanner', severity: s.severity, file_path: s.file });
      }
      for (const r of removals) {
        const row = await tx
          .insertInto('review_findings')
          .values({ run_id: run.id, patch_id: patch.id, source: 'static_analysis', severity: 'medium', file_path: r.file, start_line: r.line, end_line: r.line, title: r.title, description: r.description, evidence: json({ analyzer: 'anvaya-removed-code', deterministic: true }) })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.kit.events.emit(tx, current, 'review.finding.created', { finding_id: row.id, source: 'static_analysis', severity: 'medium', file_path: r.file });
      }
      for (const f of aiFindings) {
        const row = await tx
          .insertInto('review_findings')
          .values({
            run_id: run.id,
            patch_id: patch.id,
            source: 'ai_review',
            severity: f.severity,
            file_path: f.file_path,
            start_line: f.start_line,
            end_line: f.end_line,
            title: f.title,
            description: f.rationale,
            evidence: json({ evidence: f.evidence, confidence: f.confidence, suggested_action: f.suggested_action ?? null, deterministic: false }),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.kit.events.emit(tx, current, 'review.finding.created', { finding_id: row.id, source: 'ai_review', severity: f.severity, file_path: f.file_path });
      }
      if (!blocking) {
        const next = await this.kit.transitions.transition(tx, current, 'awaiting_pr_approval', { type: 'worker' }, { reason: 'review completed', checkpointPatch: { review_summary: parsed.data.summary } });
        await this.kit.events.emit(tx, next, 'approval.required', { approval_type: 'pull_request', patch_id: patch.id, patch_hash: patch.patch_hash });
      }
    });
    await this.kit.events.notify(run.id);
    if (blocking) {
      await this.scheduleRepairOrFail(run, { kind: 'security', detail: scanner.map((s) => `${s.file}:${s.line} ${s.title}`).join('\n') }, 'SECURITY_CHECK_FAILED', 'Deterministic security checks found blocking issues in the patch.');
      return;
    }
    // Patch content is persisted in object storage; the workspace is no longer needed.
    await this.release(run.id);
  }

  // ---------------------------------------------------------------------------
  private async scheduleRepairOrFail(run: WorkflowRun, failure: Failure, code: string, summary: string): Promise<void> {
    const budget = this.kit.budget(run);
    const used = Number(run.checkpoint.repair_attempts ?? 0);
    await this.kit.database.transaction(async (tx) => {
      const current = await this.kit.guard(tx, run);
      if (used < budget.max_repair_attempts) {
        const patch: JsonObject = { repair_attempts: used + 1, last_failure: failure };
        if (current.status === 'implementing') {
          // Stay in implementing for another bounded attempt (no state change, but checkpoint + version bump via no-op guard).
          await tx.updateTable('workflow_runs').set({ checkpoint: json({ ...current.checkpoint, ...patch }) }).where('id', '=', run.id).where('state_version', '=', current.state_version).execute();
        } else {
          await this.kit.transitions.transition(tx, current, 'implementing', { type: 'worker' }, { reason: `${summary} Repair attempt ${used + 1} of ${budget.max_repair_attempts}.`, checkpointPatch: patch });
        }
      } else {
        await this.kit.transitions.transition(tx, current, 'failed', { type: 'worker' }, { reason: summary, errorCode: code, errorSummary: `${summary} Repair budget exhausted (${budget.max_repair_attempts}).` });
      }
    });
    await this.kit.events.notify(run.id);
    if (used >= budget.max_repair_attempts) await this.release(run.id);
  }

  private async loadPatchFiles(patchId: string): Promise<Array<{ path: string; action: string; before: string | null; after: string | null; explanation?: string | null }>> {
    const p = await this.kit.database.db.selectFrom('patches').select('files_object_key').where('id', '=', patchId).executeTakeFirst();
    if (!p?.files_object_key) return [];
    const raw = await this.storage.get(p.files_object_key);
    const parsed = z.array(z.object({ path: z.string(), action: z.string(), before: z.string().nullable(), after: z.string().nullable(), explanation: z.string().nullable().optional() })).safeParse(raw ? JSON.parse(raw.toString('utf8')) : []);
    return parsed.success ? parsed.data : [];
  }
}
