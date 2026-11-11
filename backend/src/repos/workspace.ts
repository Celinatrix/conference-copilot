import type { Db, Queryable } from '../db.js';

/** SQL for workspace membership and invitations. Callers check roles first. */

/** Members plus pending invitations allowed in one workspace. */
export const WORKSPACE_SEATS = 25;

const PENDING = 'i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()';

export interface NewInvitation {
  workspaceId: string;
  tokenHash: string;
  role: 'admin' | 'member';
  email: string | null;
  createdBy: string;
  expiresInDays: number;
}

export const workspaceRepo = {
  /** What the sign-up page may show for a still-usable invite link; null for anything else. */
  async invitePreview(db: Queryable, tokenHash: string) {
    const [row] = await db.query<{ workspace: string; role: string; email: string | null; expires_at: Date }>(
      `SELECT w.name AS workspace, i.role, i.email, i.expires_at FROM invitations i JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.token_hash = $1 AND ${PENDING}`,
      [tokenHash],
    );
    return row ?? null;
  },

  members(db: Queryable, workspaceId: string) {
    return db.query<{ id: string; name: string; email: string; role: string; created_at: Date }>(
      `SELECT u.id, u.name, u.email, m.role, m.created_at FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 ORDER BY m.created_at`,
      [workspaceId],
    );
  },

  pendingInvites(db: Queryable, workspaceId: string) {
    return db.query<{ id: string; role: string; email: string | null; expires_at: Date; created_at: Date; created_by_name: string }>(
      `SELECT i.id, i.role, i.email, i.expires_at, i.created_at, u.name AS created_by_name FROM invitations i JOIN users u ON u.id = i.created_by
       WHERE i.workspace_id = $1 AND ${PENDING} ORDER BY i.created_at DESC`,
      [workspaceId],
    );
  },

  /**
   * Creates the invitation if a seat is free, else returns null. Count and insert run under a lock on the
   * workspace row, so two invites created at the same moment cannot both take the last seat.
   */
  createWithinSeats(db: Db, inv: NewInvitation): Promise<{ id: string; expires_at: Date } | null> {
    return db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [inv.workspaceId]);
      const [{ seats }] = await tx.query<{ seats: number }>(
        `SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = $1)
              + (SELECT COUNT(*) FROM invitations i WHERE i.workspace_id = $1 AND ${PENDING}) AS seats`,
        [inv.workspaceId],
      );
      if (Number(seats) >= WORKSPACE_SEATS) return null;
      const [row] = await tx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO invitations (workspace_id, token_hash, role, email, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval) RETURNING id, expires_at`,
        [inv.workspaceId, inv.tokenHash, inv.role, inv.email, inv.createdBy, String(inv.expiresInDays)],
      );
      return row;
    });
  },

  /** Revokes a not-yet-used invitation of this workspace. Returns false when there is none. */
  async revoke(db: Queryable, id: string, workspaceId: string): Promise<boolean> {
    const rows = await db.query(`UPDATE invitations SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND used_at IS NULL RETURNING id`, [
      id,
      workspaceId,
    ]);
    return rows.length > 0;
  },
};
