import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import {
  AttemptLimiter,
  SESSION_COOKIE,
  createSession,
  destroySession,
  hashPassword,
  requireUser,
  sha256,
  verifyPassword,
} from '../auth.js';
import { randomBytes } from 'node:crypto';
import { audit, primaryWorkspace } from '../access.js';

const Register = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(10, 'Mật khẩu cần ít nhất 10 ký tự').max(200),
  invite: z.string().max(100).optional(),
});

/** A real hash of a random password, so failed logins for unknown emails cost the same time as real ones. */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));
const Login = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) });

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const registerLimiter = new AttemptLimiter(ctx.config.registerPerHour, 60 * 60_000);
  const perClient = new AttemptLimiter(10);
  // Caps guessing on one account even when the attacker rotates IP addresses.
  const perAccount = new AttemptLimiter(20);
  const cookieOpts = (expires: Date) => ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.config.cookieSecure,
    expires,
  });

  app.post('/api/auth/register', async (req, reply) => {
    if (!registerLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Quá nhiều lần đăng ký. Vui lòng đợi rồi thử lại.' });
    }
    const body = Register.parse(req.body);
    const [{ users }] = await ctx.db.query<{ users: number }>('SELECT COUNT(*)::int AS users FROM users');

    // Who may register: the very first account (it becomes the owner), anyone holding a valid invite,
    // or anyone when ALLOW_SIGNUP=true. Checked before the email lookup so closed signup reveals nothing.
    let invite: { id: string; workspace_id: string; role: 'admin' | 'member' } | null = null;
    if (body.invite) {
      const [row] = await ctx.db.query<{ id: string; workspace_id: string; role: 'admin' | 'member'; email: string | null }>(
        `SELECT id, workspace_id, role, email FROM invitations
         WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
        [sha256(body.invite)],
      );
      if (!row || (row.email && row.email !== body.email)) {
        return reply.code(403).send({ error: 'invalid_invite', message: 'Link mời không hợp lệ, đã dùng, đã hết hạn hoặc dành cho email khác.' });
      }
      invite = row;
    } else if (users > 0 && !ctx.config.allowSignup) {
      return reply.code(403).send({ error: 'signup_closed', message: 'Chỉ đăng ký được bằng link mời. Hãy xin link từ quản trị viên workspace.' });
    }

    const existing = await ctx.db.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (existing.length) return reply.code(409).send({ error: 'email_taken', message: 'Email này đã được đăng ký.' });
    const passwordHash = await hashPassword(body.password);
    const user = await ctx.db.transaction(async (tx) => {
      // The checks above ran outside any lock. Two people registering at once on a fresh server would both see
      // zero users and both become owners, so the "who may register" decision is repeated here under a lock
      // that serialises registrations (and blocks the duplicate-email race the same way).
      await tx.exec('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      if (!invite && !ctx.config.allowSignup) {
        const [{ n }] = await tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
        if (n > 0) return 'signup_closed' as const;
      }
      if ((await tx.query('SELECT 1 FROM users WHERE email = $1', [body.email])).length) return 'email_taken' as const;
      const [u] = await tx.query<{ id: string; email: string; name: string }>(
        'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
        [body.email, body.name, passwordHash],
      );
      if (invite) {
        // Single use, enforced in the same transaction so two people cannot redeem one link.
        const used = await tx.query(`UPDATE invitations SET used_at = now(), used_by = $2 WHERE id = $1 AND used_at IS NULL RETURNING id`, [invite.id, u.id]);
        if (!used.length) throw Object.assign(new Error('Link mời vừa được người khác sử dụng.'), { statusCode: 409 });
        await tx.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [invite.workspace_id, u.id, invite.role]);
        await audit(tx, { workspaceId: invite.workspace_id, userId: u.id, action: 'user.register', meta: { via: 'invite', inviteId: invite.id, role: invite.role } });
      } else {
        const [w] = await tx.query<{ id: string }>('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [`Workspace của ${body.name}`]);
        await tx.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [w.id, u.id]);
        await audit(tx, { workspaceId: w.id, userId: u.id, action: 'user.register' });
      }
      return u;
    });
    if (user === 'signup_closed') {
      return reply.code(403).send({ error: 'signup_closed', message: 'Chỉ đăng ký được bằng link mời. Hãy xin link từ quản trị viên workspace.' });
    }
    if (user === 'email_taken') return reply.code(409).send({ error: 'email_taken', message: 'Email này đã được đăng ký.' });
    const session = await createSession(ctx.db, user.id);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts(session.expiresAt));
    return { user };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = Login.parse(req.body);
    const clientOk = perClient.allow(`${req.ip}:${body.email}`);
    const accountOk = perAccount.allow(body.email);
    if (!clientOk || !accountOk) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Quá nhiều lần thử. Vui lòng đợi 15 phút.' });
    }
    const [row] = await ctx.db.query<{ id: string; email: string; name: string; password_hash: string }>(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [body.email],
    );
    const valid = row ? await verifyPassword(body.password, row.password_hash) : (await verifyPassword(body.password, await getDummyHash()), false);
    if (!row || !valid) {
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Email hoặc mật khẩu không đúng.' });
    }
    const session = await createSession(ctx.db, row.id);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts(session.expiresAt));
    await audit(ctx.db, { userId: row.id, action: 'user.login' });
    return { user: { id: row.id, email: row.email, name: row.name } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(ctx.db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => {
    const workspace = await primaryWorkspace(ctx.db, req.user!.id);
    return { user: req.user, workspace };
  });
}
