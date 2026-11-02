import { Global, Injectable, Module } from '@nestjs/common';
import { redactValue } from '../common/redact.js';
import { requestContext } from '../common/request-context.js';
import { type Db, DatabaseService, type Tx } from '../database/database.service.js';
import { json } from '../database/types.js';

export interface AuditInput {
  organizationId: string | null;
  actorUserId: string | null;
  actorType?: 'user' | 'system' | 'worker' | 'provider';
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit trail (SECURITY §11). Pass the active transaction so the
 * audit row commits atomically with the change it describes.
 */
@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async record(input: AuditInput, executor: Db | Tx = this.database.db): Promise<void> {
    await executor
      .insertInto('audit_events')
      .values({
        organization_id: input.organizationId,
        actor_user_id: input.actorUserId,
        actor_type: input.actorType ?? (input.actorUserId ? 'user' : 'system'),
        action: input.action,
        resource_type: input.resourceType ?? null,
        resource_id: input.resourceId ?? null,
        request_id: requestContext.requestId() ?? null,
        metadata_redacted: json(redactValue(input.metadata ?? {})),
      })
      .execute();
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
