import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { decodeCursor, type Page, toPage } from '../common/http.js';
import { DatabaseService } from '../database/database.service.js';
import { beforeCursor, cursorUs } from '../database/keyset.js';
import { type EngineeringTask, json, type JsonObject, type Repository } from '../database/types.js';
import { GithubAppService, IMPORT_LIMITS, toAppError } from '../github/github-app.service.js';
import { AccessService } from '../workspaces/access.service.js';
import type { createTaskBody, listTasksQuery, updateTaskBody } from './run.schemas.js';
import { clean, FAILING_CONCLUSIONS, type ImportedTask, importCheckFailure, importPullRequest, safeUrl, TASK_DESCRIPTION_MAX, TASK_TITLE_MAX } from './task-sources.js';

export function taskView(t: EngineeringTask) {
  return {
    id: t.id,
    workspace_id: t.organization_id,
    repository_id: t.repository_id,
    created_by: t.created_by,
    source_type: t.source_type,
    external_number: t.external_number,
    external_id: t.external_id,
    source_url: t.source_url,
    source_context: t.source_context,
    title: t.title,
    description: t.description,
    status: t.status,
    labels: t.labels,
    created_at: t.created_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
  };
}

@Injectable()
export class TasksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly github: GithubAppService,
  ) {}

  async create(userId: string, repositoryId: string, body: z.infer<typeof createTaskBody>) {
    const { repository } = await this.access.requireRepository(userId, repositoryId, 'member');
    if (repository.status !== 'connected') throw Errors.invalidState('The repository is not connected.');
    let title = body.title;
    let description = body.description;
    let labels = body.labels;
    let externalId: string | null = null;
    let sourceUrl: string | null = null;
    let context: JsonObject = {};
    if (body.source_type !== 'manual') {
      const installationId = await this.activeInstallation(repository.installation_id);
      const imported = await this.importSource(installationId, repository, body).catch((err: unknown) => {
        throw toAppError(err);
      });
      // Imported text is untrusted repository content: stored as data, labelled untrusted in prompts.
      title ??= imported.title;
      description ??= imported.description;
      if (labels.length === 0) labels = imported.labels;
      externalId = imported.externalId;
      sourceUrl = imported.sourceUrl;
      context = imported.context;
    }
    return this.database.transaction(async (tx) => {
      const task = await tx
        .insertInto('engineering_tasks')
        .values({
          organization_id: repository.organization_id,
          repository_id: repositoryId,
          created_by: userId,
          source_type: body.source_type,
          external_number: body.external_number ?? null,
          external_id: externalId,
          source_url: sourceUrl,
          source_context: json(context),
          title: title!,
          description: description!,
          labels: json(labels),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(
        {
          organizationId: repository.organization_id,
          actorUserId: userId,
          action: 'task.created',
          resourceType: 'task',
          resourceId: task.id,
          metadata: { source_type: body.source_type, external_number: body.external_number ?? null, external_id: externalId },
        },
        tx,
      );
      return taskView(task);
    });
  }

  /** Recent failing check runs on a branch or commit, to pick one for a `failing_check` task. */
  async failingChecks(userId: string, repositoryId: string, ref: string | undefined) {
    const { repository } = await this.access.requireRepository(userId, repositoryId, 'member');
    if (repository.status !== 'connected') throw Errors.invalidState('The repository is not connected.');
    const installationId = await this.activeInstallation(repository.installation_id);
    const target = ref ?? repository.default_branch;
    if (!target) throw Errors.validation({ issues: [{ path: 'ref', message: 'the repository has no default branch; pass ref', code: 'required' }] });
    let runs;
    try {
      runs = await this.github.listCheckRuns(installationId, repository.external_repository_id, repository.full_name, target);
    } catch (err) {
      throw toAppError(err);
    }
    return {
      ref: target,
      check_runs: runs
        .filter((r) => r.status === 'completed' && FAILING_CONCLUSIONS.has(r.conclusion ?? ''))
        .map((r) => ({
          id: r.id,
          name: clean(r.name, 200),
          conclusion: r.conclusion ?? 'unknown',
          head_sha: r.head_sha.slice(0, 64),
          html_url: r.html_url ? safeUrl(r.html_url) : null,
          completed_at: r.completed_at ?? null,
          app: r.app?.slug ?? r.app?.name ?? null,
        })),
    };
  }

  private async activeInstallation(installationUuid: string | null): Promise<number> {
    const inst = installationUuid
      ? await this.database.db.selectFrom('git_installations').select(['external_installation_id', 'status']).where('id', '=', installationUuid).executeTakeFirst()
      : undefined;
    if (!inst || inst.status !== 'active') throw Errors.invalidState('The GitHub installation is not active.');
    return inst.external_installation_id;
  }

  private async importSource(installationId: number, repository: Repository, body: z.infer<typeof createTaskBody>): Promise<ImportedTask> {
    const repoId = repository.external_repository_id;
    if (body.source_type === 'github_issue') {
      const issue = await this.github.getIssue(installationId, repoId, repository.full_name, body.external_number!);
      if (issue.pull_request) throw Errors.unprocessable('NOT_AN_ISSUE', 'This number refers to a pull request, not an issue.');
      return {
        title: clean(issue.title, TASK_TITLE_MAX) || `Issue #${issue.number}`,
        description: clean(issue.body, TASK_DESCRIPTION_MAX) || '(no description)',
        labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean).slice(0, 20),
        externalId: null,
        sourceUrl: safeUrl(issue.html_url),
        context: {},
      };
    }
    if (body.source_type === 'pull_request') {
      const { pr, files, comments } = await this.github.getPullRequest(installationId, repoId, repository.full_name, body.external_number!, { includeReviewComments: body.include_review_comments ?? false });
      return importPullRequest(pr, files, comments, { files: IMPORT_LIMITS.prFiles, comments: IMPORT_LIMITS.reviewComments });
    }
    const { check, annotations } = await this.github.getCheckRun(installationId, repoId, repository.full_name, body.check_run_id!);
    if (check.status !== 'completed' || !FAILING_CONCLUSIONS.has(check.conclusion ?? '')) {
      throw Errors.unprocessable('CHECK_NOT_FAILING', 'This check run has not failed, so there is no failure to fix.', { status: check.status, conclusion: check.conclusion ?? null });
    }
    return importCheckFailure(check, annotations, { annotations: IMPORT_LIMITS.annotations });
  }

  async list(userId: string, q: z.infer<typeof listTasksQuery> & { workspace_id: string }): Promise<Page<unknown>> {
    await this.access.requireWorkspace(userId, q.workspace_id);
    const cursor = decodeCursor(q.cursor);
    let query = this.database.db
      .selectFrom('engineering_tasks as t')
      .innerJoin('repositories as repo', 'repo.id', 't.repository_id')
      .selectAll('t')
      .select('repo.full_name as repository_full_name')
      .select(cursorUs('t.created_at').as('cursor_us'))
      .where('t.organization_id', '=', q.workspace_id);
    if (q.repository_id) query = query.where('t.repository_id', '=', q.repository_id);
    if (q.status) query = query.where('t.status', '=', q.status);
    if (cursor) query = query.where(beforeCursor('t.created_at', 't.id', cursor));
    const rows = await query.orderBy('t.created_at', 'desc').orderBy('t.id', 'desc').limit(q.limit + 1).execute();
    const latest = await this.latestRuns(rows.slice(0, q.limit).map((r) => r.id));
    return toPage(rows, q.limit, ({ cursor_us: _c, repository_full_name, ...t }) => ({ ...taskView(t), repository_full_name, latest_run: latest.get(t.id) ?? null }));
  }

  async get(userId: string, taskId: string) {
    const { task } = await this.access.requireTask(userId, taskId);
    const [latest, repo] = await Promise.all([
      this.latestRuns([taskId]),
      this.database.db.selectFrom('repositories').select('full_name').where('id', '=', task.repository_id).executeTakeFirstOrThrow(),
    ]);
    return { ...taskView(task), repository_full_name: repo.full_name, latest_run: latest.get(taskId) ?? null };
  }

  /** Most recent run per task, in one query (avoids one request per list row). */
  private async latestRuns(taskIds: string[]) {
    const out = new Map<string, { id: string; run_number: number; status: string; current_stage: string | null; created_at: string }>();
    if (taskIds.length === 0) return out;
    const rows = await this.database.db
      .selectFrom('workflow_runs')
      .distinctOn('task_id')
      .select(['task_id', 'id', 'run_number', 'status', 'current_stage', 'created_at'])
      .where('task_id', 'in', taskIds)
      .orderBy('task_id')
      .orderBy('run_number', 'desc')
      .execute();
    for (const { task_id, ...r } of rows) out.set(task_id, { ...r, created_at: r.created_at.toISOString() });
    return out;
  }

  async update(userId: string, taskId: string, body: z.infer<typeof updateTaskBody>) {
    const { task } = await this.access.requireTask(userId, taskId, 'member');
    if (body.status && task.status === 'active') throw Errors.invalidState('A task with an active run cannot be archived or reopened.');
    return this.database.transaction(async (tx) => {
      const updated = await tx
        .updateTable('engineering_tasks')
        .set({
          ...(body.title ? { title: body.title } : {}),
          ...(body.description ? { description: body.description } : {}),
          ...(body.labels ? { labels: json(body.labels) } : {}),
          ...(body.status ? { status: body.status } : {}),
        })
        .where('id', '=', taskId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ organizationId: task.organization_id, actorUserId: userId, action: 'task.updated', resourceType: 'task', resourceId: taskId, metadata: { fields: Object.keys(body) } }, tx);
      return taskView(updated);
    });
  }
}
