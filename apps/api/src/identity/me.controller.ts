import { Controller, Get } from '@nestjs/common';
import { Errors } from '../common/errors.js';
import { type AuthUser, CurrentUser } from '../identity/auth.decorators.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { UsersService } from './users.service.js';

@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** Current user and memberships (API_SPEC §2). */
  @Get()
  async me(@CurrentUser() auth: AuthUser) {
    const user = await this.users.findById(auth.id);
    if (!user) throw Errors.unauthenticated();
    const workspaces = await this.workspaces.listForUser(user.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        created_at: user.created_at.toISOString(),
      },
      memberships: workspaces.map((w) => ({ workspace_id: w.id, workspace_name: w.name, workspace_slug: w.slug, role: w.role })),
    };
  }
}
