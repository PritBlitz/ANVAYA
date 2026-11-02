import { Global, Injectable, Module } from '@nestjs/common';
import { Errors } from '../common/errors.js';
import { type Db, DatabaseService, type Tx } from '../database/database.service.js';
import type { Repository, Role } from '../database/types.js';

const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export interface WorkspaceAccess {
  organizationId: string;
  role: Role;
}

/**
 * Central server-side authorization (FR-ID-004, SECURITY §5).
 *
 * Tenant scope is always derived from the caller's verified membership, never
 * from a client-supplied id alone. A caller who is not a member of the owning
 * workspace receives 404 (resource existence is concealed); a member whose role
 * is insufficient receives 403.
 */
@Injectable()
export class AccessService {
  constructor(private readonly database: DatabaseService) {}

  async membership(userId: string, organizationId: string, executor: Db | Tx = this.database.db): Promise<Role | null> {
    const row = await executor
      .selectFrom('memberships')
      .select('role')
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.role ?? null;
  }

  async requireWorkspace(userId: string, organizationId: string, min: Role = 'viewer', executor?: Db | Tx): Promise<WorkspaceAccess> {
    const role = await this.membership(userId, organizationId, executor);
    if (!role) throw Errors.notFound('Workspace');
    if (!roleAtLeast(role, min)) throw Errors.forbidden();
    return { organizationId, role };
  }

  /** Loads a repository the caller may access with at least `min` role. */
  async requireRepository(userId: string, repositoryId: string, min: Role = 'viewer'): Promise<{ repository: Repository; role: Role }> {
    const row = await this.database.db
      .selectFrom('repositories as r')
      .innerJoin('memberships as m', (j) => j.onRef('m.organization_id', '=', 'r.organization_id').on('m.user_id', '=', userId))
      .selectAll('r')
      .select('m.role as member_role')
      .where('r.id', '=', repositoryId)
      .executeTakeFirst();
    if (!row) throw Errors.notFound('Repository');
    const { member_role, ...repository } = row;
    if (!roleAtLeast(member_role, min)) throw Errors.forbidden();
    return { repository, role: member_role };
  }

  async requireTask(userId: string, taskId: string, min: Role = 'viewer') {
    const row = await this.database.db
      .selectFrom('engineering_tasks as t')
      .innerJoin('memberships as m', (j) => j.onRef('m.organization_id', '=', 't.organization_id').on('m.user_id', '=', userId))
      .selectAll('t')
      .select('m.role as member_role')
      .where('t.id', '=', taskId)
      .executeTakeFirst();
    if (!row) throw Errors.notFound('Task');
    const { member_role, ...task } = row;
    if (!roleAtLeast(member_role, min)) throw Errors.forbidden();
    return { task, role: member_role };
  }

  async requireRun(userId: string, runId: string, min: Role = 'viewer') {
    const row = await this.database.db
      .selectFrom('workflow_runs as r')
      .innerJoin('memberships as m', (j) => j.onRef('m.organization_id', '=', 'r.organization_id').on('m.user_id', '=', userId))
      .selectAll('r')
      .select('m.role as member_role')
      .where('r.id', '=', runId)
      .executeTakeFirst();
    if (!row) throw Errors.notFound('Run');
    const { member_role, ...run } = row;
    if (!roleAtLeast(member_role, min)) throw Errors.forbidden();
    return { run, role: member_role };
  }
}

@Global()
@Module({ providers: [AccessService], exports: [AccessService] })
export class AccessModule {}
