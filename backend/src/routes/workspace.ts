import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { requireUser, sha256 } from '../auth.js';
import { audit, primaryWorkspace } from '../access.js';
import { isUuid, notFound, toIsoOrNull as iso } from '../http.js';
import { WORKSPACE_SEATS, workspaceRepo } from '../repos/workspace.js';

export { WORKSPACE_SEATS };

const NewInvite = z.object({
  role: z.enum(['admin', 'member']).default('member'),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  expiresInDays: z.number().int().min(1).max(14).default(7),
});

export function workspaceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  /** Public: lets the sign-up page show which workspace an invite is for. Reveals nothing for bad tokens. */
  app.get('/api/invites/:token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    if (token.length > 100) return notFound(reply, 'Link mời không hợp lệ.');
    const row = await workspaceRepo.invitePreview(db, sha256(token));
    if (!row) return notFound(reply, 'Link mời không hợp lệ, đã dùng hoặc đã hết hạn.');
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
      if (!ws) return notFound(reply, 'Chưa thuộc workspace nào.');
      const members = await workspaceRepo.members(db, ws.workspace_id);
      return { workspace: { name: ws.name, role: ws.role }, members: members.map((m) => ({ ...m, created_at: iso(m.created_at) })) };
    });

    scope.get('/api/workspace/invites', async (req, reply) => {
      const ws = await manager(req.user!.id, reply);
      if (!ws) return reply;
      const rows = await workspaceRepo.pendingInvites(db, ws.workspace_id);
      return { invites: rows.map((r) => ({ ...r, expires_at: iso(r.expires_at), created_at: iso(r.created_at) })) };
    });

    scope.post('/api/workspace/invites', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
      const ws = await manager(req.user!.id, reply);
      if (!ws) return reply;
      const body = NewInvite.parse(req.body ?? {});
      if (body.role === 'admin' && ws.role !== 'owner') {
        return reply.code(403).send({ error: 'forbidden', message: 'Chỉ Owner mới mời được Admin.' });
      }
      const token = randomBytes(24).toString('base64url');
      const invite = await workspaceRepo.createWithinSeats(db, {
        workspaceId: ws.workspace_id,
        tokenHash: sha256(token),
        role: body.role,
        email: body.email ?? null,
        createdBy: req.user!.id,
        expiresInDays: body.expiresInDays,
      });
      if (!invite) {
        return reply.code(409).send({ error: 'workspace_full', message: `Workspace đã đủ ${WORKSPACE_SEATS} thành viên và lời mời đang chờ.` });
      }
      await audit(db, {
        workspaceId: ws.workspace_id,
        userId: req.user!.id,
        action: 'invite.create',
        targetType: 'invitation',
        targetId: invite.id,
        meta: { role: body.role, email: body.email ?? null },
      });
      // The raw token exists only in this response; the database keeps its hash.
      return reply
        .code(201)
        .send({ invite: { id: invite.id, role: body.role, email: body.email ?? null, expires_at: iso(invite.expires_at) }, path: `/login?invite=${token}` });
    });

    scope.delete('/api/workspace/invites/:id', async (req, reply) => {
      const ws = await manager(req.user!.id, reply);
      if (!ws) return reply;
      const { id } = req.params as { id: string };
      if (!isUuid(id)) return notFound(reply);
      if (!(await workspaceRepo.revoke(db, id, ws.workspace_id))) return notFound(reply, 'Không tìm thấy lời mời.');
      await audit(db, { workspaceId: ws.workspace_id, userId: req.user!.id, action: 'invite.revoke', targetType: 'invitation', targetId: id });
      return { ok: true };
    });
  });
}
