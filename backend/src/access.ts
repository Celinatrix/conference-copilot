import type { Queryable } from './db.js';
import { isUuid } from './http.js';

export type Role = 'owner' | 'admin' | 'member';

export interface ConferenceRow {
  id: string;
  workspace_id: string;
  created_by: string;
  name: string;
  starts_at: string | Date | null;
  location: string;
  speakers: string;
  input_language: string;
  glossary: string;
  visibility: 'private' | 'workspace';
  status: 'draft' | 'live' | 'paused' | 'ended';
  /** Up to 3 suggested-answer styles, e.g. ["professional","concise","strategic"]. */
  response_modes?: string[];
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ConferenceAccess {
  conference: ConferenceRow;
  role: Role;
  canView: boolean;
  /** Start/stop listening, edit transcript, change settings. */
  canManage: boolean;
  /** Permanently delete the conference and its data. */
  canDelete: boolean;
}

/**
 * Pure access rule, kept separate so it can be unit-tested.
 * - private: only the creator sees it (owners/admins do NOT get implicit access to personal content).
 * - workspace: every member can view; the creator, owners and admins can manage.
 */
export function evaluateAccess(conference: ConferenceRow, userId: string, role: Role | null): ConferenceAccess | null {
  if (!role) return null;
  const isCreator = conference.created_by === userId;
  const canView = isCreator || conference.visibility === 'workspace';
  if (!canView) return null;
  const elevated = role === 'owner' || role === 'admin';
  return {
    conference,
    role,
    canView,
    canManage: isCreator || (conference.visibility === 'workspace' && elevated),
    canDelete: isCreator || (conference.visibility === 'workspace' && role === 'owner'),
  };
}

export async function getConferenceAccess(db: Queryable, conferenceId: string, userId: string) {
  if (!isUuid(conferenceId)) return null;
  const rows = await db.query<ConferenceRow & { role: Role | null }>(
    `SELECT c.*, m.role FROM conferences c
     LEFT JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = $2
     WHERE c.id = $1`,
    [conferenceId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  const { role, ...conference } = row;
  return evaluateAccess(conference, userId, role);
}

export async function primaryWorkspace(db: Queryable, userId: string) {
  const rows = await db.query<{ workspace_id: string; role: Role; name: string }>(
    `SELECT m.workspace_id, m.role, w.name FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 ORDER BY m.created_at ASC LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function audit(
  db: Queryable,
  entry: { workspaceId?: string | null; userId?: string | null; action: string; targetType?: string; targetId?: string; meta?: object },
) {
  await db.query(
    `INSERT INTO audit_logs (workspace_id, user_id, action, target_type, target_id, meta) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      entry.workspaceId ?? null,
      entry.userId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(entry.meta ?? {}),
    ],
  );
}
