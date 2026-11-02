import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Errors } from '../common/errors.js';
import { DatabaseService } from '../database/database.service.js';
import type { User } from '../database/types.js';

export interface ExternalIdentity {
  /** Stable subject from the identity provider, e.g. `github:12345`. */
  subject: string;
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Creates or updates the user for an external identity. A different subject
   * may not claim an email already bound to another account (prevents account
   * takeover via an unverified/duplicate email).
   */
  async upsertFromIdentity(identity: ExternalIdentity): Promise<User> {
    const email = identity.email.trim().toLowerCase();
    return this.database.transaction(async (tx) => {
      const bySubject = await tx.selectFrom('users').selectAll().where('auth_subject', '=', identity.subject).executeTakeFirst();
      if (bySubject) {
        const clash = await tx
          .selectFrom('users')
          .select('id')
          .where(sql`lower(email)`, '=', email)
          .where('id', '!=', bySubject.id)
          .executeTakeFirst();
        return tx
          .updateTable('users')
          .set({
            email: clash ? bySubject.email : email,
            display_name: identity.displayName ?? bySubject.display_name,
            avatar_url: identity.avatarUrl ?? bySubject.avatar_url,
          })
          .where('id', '=', bySubject.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const byEmail = await tx.selectFrom('users').select('id').where(sql`lower(email)`, '=', email).executeTakeFirst();
      if (byEmail) throw Errors.conflict('EMAIL_IN_USE', 'This email address is linked to a different sign-in method.');
      return tx
        .insertInto('users')
        .values({
          auth_subject: identity.subject,
          email,
          display_name: identity.displayName ?? null,
          avatar_url: identity.avatarUrl ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async findById(id: string): Promise<User | undefined> {
    return this.database.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  }
}
