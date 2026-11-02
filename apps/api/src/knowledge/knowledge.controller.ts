import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { sha256Hex } from '../common/crypto.js';
import { Errors } from '../common/errors.js';
import { decodeCursor, paginationQuery, toPage, UuidParamPipe, ZodPipe } from '../common/http.js';
import { Idempotent } from '../common/idempotency.js';
import { DatabaseService } from '../database/database.service.js';
import { beforeCursor, cursorUs } from '../database/keyset.js';
import type { KnowledgeDocumentsTable } from '../database/types.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { ObjectStorage } from '../storage/object-storage.js';
import { KnowledgeIndexService } from './knowledge-index.service.js';
import { AccessService, roleAtLeast } from '../workspaces/access.service.js';
import type { Selectable } from 'kysely';

export const createKnowledgeBody = z
  .object({
    source_type: z.enum(['engineering_note', 'decision', 'architecture']),
    title: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(100_000),
    source_url: z
      .url({ protocol: /^https$/ })
      .max(2000)
      .optional(),
  })
  .strict();

export const listKnowledgeQuery = paginationQuery.extend({ source_type: z.enum(['readme', 'architecture', 'decision', 'issue', 'pull_request', 'engineering_note']).optional() });

function key(organizationId: string, documentId: string): string {
  return `knowledge/${organizationId}/${documentId}`;
}

function view(d: Selectable<KnowledgeDocumentsTable>) {
  return {
    id: d.id,
    workspace_id: d.organization_id,
    repository_id: d.repository_id,
    source_type: d.source_type,
    title: d.title,
    content_hash: d.content_hash,
    source_url: d.source_url,
    created_by: d.created_by,
    indexed_at: d.indexed_at?.toISOString() ?? null,
    created_at: d.created_at.toISOString(),
  };
}

/**
 * Engineering knowledge documents (API_SPEC §4). Content is stored in object
 * storage; rows hold metadata and a content hash. Notes are treated as
 * untrusted content like any repository document.
 */
@Controller()
export class KnowledgeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly storage: ObjectStorage,
    private readonly audit: AuditService,
    private readonly index: KnowledgeIndexService,
  ) {}

  @Get('repositories/:repositoryId/knowledge')
  async list(@CurrentUser() user: AuthUser, @Param('repositoryId', new UuidParamPipe('Repository')) repositoryId: string, @Query(new ZodPipe(listKnowledgeQuery)) q: z.infer<typeof listKnowledgeQuery>) {
    await this.access.requireRepository(user.id, repositoryId);
    const cursor = decodeCursor(q.cursor);
    let query = this.database.db.selectFrom('knowledge_documents').selectAll().select(cursorUs('created_at').as('cursor_us')).where('repository_id', '=', repositoryId);
    if (q.source_type) query = query.where('source_type', '=', q.source_type);
    if (cursor) query = query.where(beforeCursor('created_at', 'id', cursor));
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.limit + 1).execute();
    return toPage(rows, q.limit, ({ cursor_us: _c, ...d }) => view(d));
  }

  @Post('repositories/:repositoryId/knowledge')
  @Idempotent()
  async create(
    @CurrentUser() user: AuthUser,
    @Param('repositoryId', new UuidParamPipe('Repository')) repositoryId: string,
    @Body(new ZodPipe(createKnowledgeBody)) body: z.infer<typeof createKnowledgeBody>,
  ) {
    const { repository } = await this.access.requireRepository(user.id, repositoryId, 'member');
    const doc = await this.database.transaction(async (tx) => {
      const row = await tx
        .insertInto('knowledge_documents')
        .values({
          organization_id: repository.organization_id,
          repository_id: repositoryId,
          source_type: body.source_type,
          title: body.title,
          content_hash: `sha256:${sha256Hex(body.content)}`,
          source_url: body.source_url ?? null,
          created_by: user.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const objectKey = key(repository.organization_id, row.id);
      await this.storage.put(objectKey, body.content);
      const updated = await tx.updateTable('knowledge_documents').set({ content_object_key: objectKey }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record({ organizationId: repository.organization_id, actorUserId: user.id, action: 'knowledge.created', resourceType: 'knowledge_document', resourceId: row.id }, tx);
      return updated;
    });
    // Chunk and embed right away so the note is usable in Q&A immediately; embedding failures degrade to lexical search.
    const indexed = await this.index.indexDocument(doc.id, body.content);
    const fresh = await this.database.db.selectFrom('knowledge_documents').selectAll().where('id', '=', doc.id).executeTakeFirstOrThrow();
    return { ...view(fresh), content: body.content, chunks: indexed.chunks, embedded_chunks: indexed.embedded };
  }

  @Get('knowledge/:documentId')
  async get(@CurrentUser() user: AuthUser, @Param('documentId', new UuidParamPipe('Document')) documentId: string) {
    const doc = await this.load(user.id, documentId);
    const content = doc.content_object_key ? await this.storage.get(doc.content_object_key) : null;
    return { ...view(doc), content: content?.toString('utf8') ?? null };
  }

  @Delete('knowledge/:documentId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('documentId', new UuidParamPipe('Document')) documentId: string): Promise<void> {
    const doc = await this.load(user.id, documentId);
    const role = (await this.access.membership(user.id, doc.organization_id))!;
    if (doc.created_by !== user.id && !roleAtLeast(role, 'admin')) throw Errors.forbidden('Only the author or an admin can delete this document.');
    if (!roleAtLeast(role, 'member')) throw Errors.forbidden();
    await this.database.transaction(async (tx) => {
      await tx.deleteFrom('knowledge_documents').where('id', '=', documentId).execute();
      await this.audit.record({ organizationId: doc.organization_id, actorUserId: user.id, action: 'knowledge.deleted', resourceType: 'knowledge_document', resourceId: documentId, metadata: { title: doc.title } }, tx);
    });
    if (doc.content_object_key) await this.storage.deletePrefix(doc.content_object_key);
  }

  private async load(userId: string, documentId: string) {
    const doc = await this.database.db.selectFrom('knowledge_documents').selectAll().where('id', '=', documentId).executeTakeFirst();
    if (!doc || !(await this.access.membership(userId, doc.organization_id))) throw Errors.notFound('Document');
    return doc;
  }
}
