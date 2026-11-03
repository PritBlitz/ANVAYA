import { Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/errors.js';
import { DatabaseService } from '../database/database.service.js';
import { json, type WorkflowTemplatesTable } from '../database/types.js';
import { AccessService } from '../workspaces/access.service.js';
import {
  BUILTIN_TEMPLATES,
  builtinTemplate,
  type createTemplateBody,
  type TemplateDefinition,
  type TemplateSnapshot,
  taskDefaultsSchema,
  templateBudgetSchema,
  type updateTemplateBody,
} from './templates.js';

type Row = Selectable<WorkflowTemplatesTable>;

function definitionFromRow(r: Row): TemplateDefinition {
  return {
    key: r.key,
    name: r.name,
    description: r.description,
    workflow: r.workflow,
    task_defaults: taskDefaultsSchema.parse(r.task_defaults),
    budget: templateBudgetSchema.parse(r.budget),
    allowed_profiles: r.allowed_profiles,
    planning_guidance: r.planning_guidance,
  };
}

export function templateView(t: TemplateDefinition, meta: { source: 'builtin' | 'workspace'; id: string | null; version: number; status: 'active' | 'archived'; created_at: Date | null; updated_at: Date | null }) {
  return {
    key: t.key,
    id: meta.id,
    source: meta.source,
    name: t.name,
    description: t.description,
    workflow: t.workflow,
    plan_only: t.workflow === 'migration_plan',
    task_defaults: t.task_defaults,
    budget: t.budget,
    allowed_profiles: t.allowed_profiles,
    planning_guidance: t.planning_guidance,
    version: meta.version,
    status: meta.status,
    created_at: meta.created_at?.toISOString() ?? null,
    updated_at: meta.updated_at?.toISOString() ?? null,
  };
}

const builtinView = (t: TemplateDefinition) => templateView(t, { source: 'builtin', id: null, version: 1, status: 'active', created_at: null, updated_at: null });
const rowView = (r: Row) => templateView(definitionFromRow(r), { source: 'workspace', id: r.id, version: r.version, status: r.status, created_at: r.created_at, updated_at: r.updated_at });

/**
 * Workflow templates: built-ins (read-only, application-owned) plus workspace
 * templates managed by admins. Every change to a workspace template is audited.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string, workspaceId: string, includeArchived: boolean) {
    await this.access.requireWorkspace(userId, workspaceId);
    let q = this.database.db.selectFrom('workflow_templates').selectAll().where('organization_id', '=', workspaceId);
    if (!includeArchived) q = q.where('status', '=', 'active');
    const rows = await q.orderBy('key').execute();
    return [...BUILTIN_TEMPLATES.map(builtinView), ...rows.map(rowView)];
  }

  async create(userId: string, workspaceId: string, body: z.infer<typeof createTemplateBody>) {
    return this.database.transaction(async (tx) => {
      await this.access.requireWorkspace(userId, workspaceId, 'admin', tx);
      const existing = await tx.selectFrom('workflow_templates').select('id').where('organization_id', '=', workspaceId).where('key', '=', body.key).executeTakeFirst();
      if (existing) throw Errors.conflict('TEMPLATE_KEY_TAKEN', 'A template with this key already exists in the workspace.', { template_id: existing.id });
      const row = await tx
        .insertInto('workflow_templates')
        .values({
          organization_id: workspaceId,
          key: body.key,
          name: body.name,
          description: body.description,
          workflow: body.workflow,
          task_defaults: json(body.task_defaults),
          budget: json(body.budget),
          allowed_profiles: body.allowed_profiles === null ? null : json(body.allowed_profiles),
          planning_guidance: json(body.planning_guidance),
          created_by: userId,
          updated_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(
        { organizationId: workspaceId, actorUserId: userId, action: 'template.created', resourceType: 'workflow_template', resourceId: row.id, metadata: { key: row.key, workflow: row.workflow, after: definitionFromRow(row) } },
        tx,
      );
      return rowView(row);
    });
  }

  async update(userId: string, workspaceId: string, templateId: string, body: z.infer<typeof updateTemplateBody>) {
    return this.database.transaction(async (tx) => {
      await this.access.requireWorkspace(userId, workspaceId, 'admin', tx);
      const current = await tx.selectFrom('workflow_templates').selectAll().where('id', '=', templateId).where('organization_id', '=', workspaceId).forUpdate().executeTakeFirst();
      if (!current) throw Errors.notFound('Template');
      const row = await tx
        .updateTable('workflow_templates')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.workflow !== undefined ? { workflow: body.workflow } : {}),
          ...(body.task_defaults !== undefined ? { task_defaults: json(body.task_defaults) } : {}),
          ...(body.budget !== undefined ? { budget: json(body.budget) } : {}),
          ...(body.allowed_profiles !== undefined ? { allowed_profiles: body.allowed_profiles === null ? null : json(body.allowed_profiles) } : {}),
          ...(body.planning_guidance !== undefined ? { planning_guidance: json(body.planning_guidance) } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          version: current.version + 1,
          updated_by: userId,
          updated_at: new Date(),
        })
        .where('id', '=', templateId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const action = body.status === 'archived' && current.status !== 'archived' ? 'template.archived' : 'template.updated';
      await this.audit.record(
        {
          organizationId: workspaceId,
          actorUserId: userId,
          action,
          resourceType: 'workflow_template',
          resourceId: templateId,
          metadata: { key: row.key, version: row.version, fields: Object.keys(body), before: { ...definitionFromRow(current), status: current.status }, after: { ...definitionFromRow(row), status: row.status } },
        },
        tx,
      );
      return rowView(row);
    });
  }

  async archive(userId: string, workspaceId: string, templateId: string): Promise<void> {
    await this.update(userId, workspaceId, templateId, { status: 'archived' });
  }

  /** Resolves an active template for task creation into the snapshot stored on the task. */
  async resolveForTask(organizationId: string, key: string): Promise<TemplateSnapshot> {
    const builtin = builtinTemplate(key);
    if (builtin) return { ...builtin, source: 'builtin', template_id: null, version: 1 };
    const row = await this.database.db.selectFrom('workflow_templates').selectAll().where('organization_id', '=', organizationId).where('key', '=', key).executeTakeFirst();
    if (!row) throw Errors.unprocessable('TEMPLATE_NOT_FOUND', `No template '${key}' exists in this workspace.`);
    if (row.status !== 'active') throw Errors.unprocessable('TEMPLATE_ARCHIVED', `The template '${key}' is archived.`);
    return { ...definitionFromRow(row), source: 'workspace', template_id: row.id, version: row.version };
  }
}
