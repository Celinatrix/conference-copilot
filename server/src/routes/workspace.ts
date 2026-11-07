import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { requireUser, sha256 } from '../auth.js';
import { audit, primaryWorkspace } from '../access.js';

const NewInvite = z.object({
  role: z.enum(['admin', 'member']).default('member'),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  expiresInDays: z.number().int().min(1).max(14).default(7),
});

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null ? null : String(v));

export function workspaceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  /** Public: lets the sign-up page show which workspace an invite is for. Reveals nothing for bad tokens. */
  app.get('/api/invites/:token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    if (token.length > 100) return reply.code(404).send({ error: 'not_found', message: 'Link mời không hợp lệ.' });
    const [row] = await db.query<{ workspace: string; role: string; email: string | null; expires_at: Date }>(
      `SELECT w.name AS workspace, i.role, i.email, i.expires_at FROM invitations i JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [sha256(token)],
    );
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'Link mời không hợp lệ, đã dùng hoặc đã hết hạn.' });
    return { workspace: row.workspace, role: row.role, email: row.email, expires_at: iso(row.expires_at) };
  });

  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);

    const manager = async (userId: string, reply: FastifyReply) => {
      const ws = await primaryWorkspace(db, userId);
      if (!ws || (ws.role !== 'owner' && ws.role !== 'admin')) {
        await reply.code(403).send({ error: 'forbidden', message: 'Chỉ Owner hoặc Admin mới quản lý được lời mời.' });
        return null;
      }
      return ws;
    };

    scope.get('/api/workspace/members', async (req, reply) => {
      const ws = await primaryWorkspace(db, req.user!.id);
      if (!ws) return reply.code(404).send({ error: 'not_found', message: 'Chưa thuộc workspace nào.' });
      const members = await db.query(
        `SELECT u.id, u.name, u.email, m.role, m.created_at FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = $1 ORDER BY m.created_at`,
        [ws.workspace_id],
      );
      return { workspace: { name: ws.name, role: ws.role }, members: members.map((m: any) => ({ ...m, created_at: iso(m.created_at) })) };
    });

    scope.get('/api/workspace/invites', async (req, reply) => {
      const ws = await manager(req.user!.id, reply);
      if (!ws) return reply;
      const rows = await db.query(
        `SELECT i.id, i.role, i.email, i.expires_at, i.created_at, u.name AS created_by_name FROM invitations i JOIN users u ON u.id = i.created_by
         WHERE i.workspace_id = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`,
        [ws.workspace_id],
      );
      return { invites: rows.map((r: any) => ({ ...r, expires_at: iso(r.expires_at), created_at: iso(r.created_at) })) };
    });

    scope.post('/api/workspace/invites', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
      const ws = await manager(req.user!.id, reply);
      if (!ws) return reply;
      const body = NewInvite.parse(req.body ?? {});
      if (body.role === 'admin' && ws.role !== 'owner') {
        return reply.code(403).send({ error: 'forbidden', message: 'Chỉ Owner mới mời được Admin.' });
      }
      const [{ seats }] = await db.query<{ seats: number }>(
        `SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = $1)
              + (SELECT COUNT(*) FROM invitations WHERE workspace_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS seats`,
        [ws.workspace_id],
      );
      if (Number(seats) >= 25) return reply.code(409).send({ error: 'workspace_full', message: 'Workspace đã đủ 25 thành viên và lời mời đang chờ.' });
      const token = randomBytes(24).toString('base64url');
      const [invite] = await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO invitations (workspace_id, token_hash, role, email, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval) RETURNING id, expires_at`,
        [ws.workspace_id, sha256(token), body.role, body.email ?? null, req.user!.id, String(body.expiresInDays)],
      );
      await audit(db, { workspaceId: ws.workspace_id, userId: req.user!.id, action: 'invite.create', targetType: 'invitation', targetId: invite.id, meta: { role: body.role, email: body.email ?? null } });
      // The raw token exists only in this response; the database keeps its hash.
      return reply.code(201).send({ invite: { id: invite.id, role: body.role, email: body.email ?? null, expires_at: iso(invite.expires_at) }, path: `/login?invite=${token}` });
    });

    scope.delete('/api/workspace/invites/:id', async (req, reply) => {
      const ws = await manager(req.user!.id, reply);
      if (!ws) return reply;
      const { id } = req.params as { id: string };
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send({ error: 'not_found', message: 'Không tìm thấy.' });
      const rows = await db.query(`UPDATE invitations SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND used_at IS NULL RETURNING id`, [id, ws.workspace_id]);
      if (!rows.length) return reply.code(404).send({ error: 'not_found', message: 'Không tìm thấy lời mời.' });
      await audit(db, { workspaceId: ws.workspace_id, userId: req.user!.id, action: 'invite.revoke', targetType: 'invitation', targetId: id });
      return { ok: true };
    });
  });
}
