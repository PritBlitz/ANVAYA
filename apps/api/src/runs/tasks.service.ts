import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { decodeCursor, type Page, toPage } from '../common/http.js';
import { DatabaseService } from '../database/database.service.js';
import { beforeCursor, cursorUs } from '../database/keyset.js';
import { type EngineeringTask, json } from '../database/types.js';
import { GithubAppService, toAppError } from '../github/github-app.service.js';
import { AccessService } from '../workspaces/access.service.js';
import type { createTaskBody, listTasksQuery, updateTaskBody } from './run.schemas.js';

export function taskView(t: EngineeringTask) {
  return {
    id: t.id,
    workspace_id: t.organization_id,
    repository_id: t.repository_id,
    created_by: t.created_by,
    source_type: t.source_type,
    external_number: t.external_number,
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
    if (body.source_type === 'github_issue') {
      const inst = repository.installation_id
        ? await this.database.db.selectFrom('git_installations').select(['external_installation_id', 'status']).where('id', '=', repository.installation_id).executeTakeFirst()
        : undefined;
      if (!inst || inst.status !== 'active') throw Errors.invalidState('The GitHub installation is not active.');
      let issue;
      try {
        issue = await this.github.getIssue(inst.external_installation_id, repository.external_repository_id, repository.full_name, body.external_number!);
      } catch (err) {
        throw toAppError(err);
      }
      if (issue.pull_request) throw Errors.unprocessable('NOT_AN_ISSUE', 'This number refers to a pull request, not an issue.');
      // Issue text is untrusted repository content: stored as data, labelled untrusted in prompts.
      title ??= issue.title.slice(0, 300);
      description ??= (issue.body ?? '').slice(0, 20_000) || '(no description)';
      if (labels.length === 0) labels = issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean).slice(0, 20);
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
          title: title!,
          description: description!,
          labels: json(labels),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record({ organizationId: repository.organization_id, actorUserId: userId, action: 'task.created', resourceType: 'task', resourceId: task.id, metadata: { source_type: body.source_type } }, tx);
      return taskView(task);
    });
  }

  async list(userId: string, q: z.infer<typeof listTasksQuery>): Promise<Page<unknown>> {
    await this.access.requireWorkspace(userId, q.workspace_id);
    const cursor = decodeCursor(q.cursor);
    let query = this.database.db.selectFrom('engineering_tasks').selectAll().select(cursorUs('created_at').as('cursor_us')).where('organization_id', '=', q.workspace_id);
    if (q.repository_id) query = query.where('repository_id', '=', q.repository_id);
    if (q.status) query = query.where('status', '=', q.status);
    if (cursor) query = query.where(beforeCursor('created_at', 'id', cursor));
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.limit + 1).execute();
    return toPage(rows, q.limit, ({ cursor_us: _c, ...t }) => taskView(t));
  }

  async get(userId: string, taskId: string) {
    const { task } = await this.access.requireTask(userId, taskId);
    const latestRun = await this.database.db
      .selectFrom('workflow_runs')
      .select(['id', 'run_number', 'status', 'current_stage', 'created_at'])
      .where('task_id', '=', taskId)
      .orderBy('run_number', 'desc')
      .limit(1)
      .executeTakeFirst();
    return { ...taskView(task), latest_run: latestRun ? { ...latestRun, created_at: latestRun.created_at.toISOString() } : null };
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
