import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError, Errors } from './errors.js';

/**
 * Workspace selection for endpoints that have no workspace in the path
 * (contract item GAP-02). A client may send the workspace either as the
 * `X-Workspace-Id` header or as an explicit `workspace_id` query/body field.
 *
 * The header only selects a workspace; it never grants access. Every caller
 * still goes through `AccessService.requireWorkspace` (non-members get 404).
 * Endpoints that address a resource by id (e.g. `/runs/:id`) ignore the
 * header and authorize against the resource's own workspace.
 */
export const WORKSPACE_HEADER = 'x-workspace-id';

const uuid = z.uuid();

/** Raw `X-Workspace-Id` header: a valid UUID, or undefined when absent. Malformed → 422. */
export const WorkspaceHeader = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const raw = ctx.switchToHttp().getRequest<Request>().header(WORKSPACE_HEADER);
  if (raw === undefined || raw === '') return undefined;
  const parsed = uuid.safeParse(raw.trim());
  if (!parsed.success) {
    throw Errors.validation({ issues: [{ path: 'X-Workspace-Id', message: 'must be a UUID', code: 'invalid_format' }] });
  }
  return parsed.data.toLowerCase();
});

/** Combine header and explicit field. Missing → 422; both present and different → 400 WORKSPACE_MISMATCH. */
export function resolveWorkspaceId(header: string | undefined, explicit: string | undefined): string {
  const fromField = explicit?.toLowerCase();
  if (header && fromField && header !== fromField) {
    throw new AppError(400, 'WORKSPACE_MISMATCH', 'X-Workspace-Id and workspace_id refer to different workspaces.');
  }
  const id = fromField ?? header;
  if (!id) {
    throw Errors.validation({ issues: [{ path: 'workspace_id', message: 'workspace_id or the X-Workspace-Id header is required', code: 'invalid_type' }] });
  }
  return id;
}
