import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../app.js';
import { requireUser } from '../auth.js';
import { audit, getConferenceAccess } from '../access.js';
import { chunkUnits, detectKind } from '../kb/parse.js';
import { UnsafeUploadError, checkSignature, inspectZip } from '../kb/safety.js';
import { parseInWorker } from '../kb/run-parse.js';

/** Extracted text caps: one document, and everything uploaded to one conference. */
export const MAX_DOCUMENT_CHARS = 2_000_000;
export const MAX_CONFERENCE_CHARS = 10_000_000;

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found', message: 'Không tìm thấy.' });

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const toDto = (r: any) => ({ ...r, created_at: iso(r.created_at) });

export function documentRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', requireUser);

  app.get('/api/conferences/:id/documents', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    const rows = await db.query(
      `SELECT id, conference_id, uploaded_by, filename, kind, size_bytes, status, error, unit_count, char_count, warning, created_at
       FROM documents WHERE conference_id = $1 ORDER BY created_at`,
      [id],
    );
    return { documents: rows.map(toDto) };
  });

  app.post('/api/conferences/:id/documents', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    if (!access.canManage) return reply.code(403).send({ error: 'forbidden', message: 'Bạn không có quyền thêm tài liệu.' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no_file', message: 'Chưa chọn file.' });
    const filename = file.filename.slice(0, 200);
    const kind = detectKind(filename);
    if (!kind) return reply.code(400).send({ error: 'unsupported', message: 'Chỉ hỗ trợ PDF, DOCX, PPTX, XLSX, CSV.' });
    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'too_large', message: 'File vượt quá 25 MB.' });
    }

    // Structural checks before any parser sees the bytes; refused files leave no row behind.
    try {
      checkSignature(buf, kind);
      if (kind === 'docx' || kind === 'pptx' || kind === 'xlsx') inspectZip(buf);
    } catch (err) {
      if (!(err instanceof UnsafeUploadError)) throw err;
      await audit(db, { workspaceId: access.conference.workspace_id, userId: req.user!.id, action: 'document.rejected', targetType: 'conference', targetId: id, meta: { filename, reason: err.code } });
      return reply.code(422).send({ error: err.code, message: err.message });
    }
    const [{ used }] = await db.query<{ used: number }>(`SELECT COALESCE(SUM(char_count), 0)::int AS used FROM documents WHERE conference_id = $1`, [id]);
    if (used >= MAX_CONFERENCE_CHARS) {
      return reply.code(413).send({ error: 'kb_full', message: 'Kho tài liệu của hội nghị này đã đầy. Hãy xóa bớt tài liệu cũ.' });
    }

    const [doc] = await db.query<{ id: string }>(
      `INSERT INTO documents (conference_id, uploaded_by, filename, kind, size_bytes) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [id, req.user!.id, filename, kind, buf.length],
    );
    try {
      const parsed = await parseInWorker(buf, filename);
      const chunks = chunkUnits(parsed.units);
      const chars = chunks.reduce((n, c) => n + c.content.length, 0);
      if (chars > MAX_DOCUMENT_CHARS) throw new Error(`tài liệu quá dài (${chars.toLocaleString('vi-VN')} ký tự, tối đa ${MAX_DOCUMENT_CHARS.toLocaleString('vi-VN')}).`);
      if (used + chars > MAX_CONFERENCE_CHARS) throw new Error('vượt dung lượng kho tài liệu của hội nghị.');
      await db.transaction(async (tx) => {
        for (const c of chunks) {
          await tx.query(
            `INSERT INTO document_chunks (document_id, conference_id, ordinal, locator, content) VALUES ($1, $2, $3, $4, $5)`,
            [doc.id, id, c.ordinal, c.locator, c.content],
          );
        }
        await tx.query(
          `UPDATE documents SET status = $2, unit_count = $3, char_count = $4, warning = $5, error = $6 WHERE id = $1`,
          [
            doc.id,
            chunks.length ? 'ready' : 'error',
            parsed.unitCount,
            chars,
            parsed.warning,
            chunks.length ? null : parsed.warning ?? 'Không trích xuất được nội dung.',
          ],
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Không đọc được file';
      req.log.warn({ err, filename }, 'document parse failed');
      await db.query(`UPDATE documents SET status = 'error', error = $2 WHERE id = $1`, [doc.id, `Không đọc được file: ${message}`.slice(0, 500)]);
    }
    await audit(db, { workspaceId: access.conference.workspace_id, userId: req.user!.id, action: 'document.upload', targetType: 'document', targetId: doc.id, meta: { filename, bytes: buf.length } });
    const [row] = await db.query(
      `SELECT id, conference_id, uploaded_by, filename, kind, size_bytes, status, error, unit_count, char_count, warning, created_at FROM documents WHERE id = $1`,
      [doc.id],
    );
    return reply.code(201).send({ document: toDto(row) });
  });

  app.delete('/api/documents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound(reply);
    const [doc] = await db.query<{ conference_id: string; filename: string }>('SELECT conference_id, filename FROM documents WHERE id = $1', [id]);
    if (!doc) return notFound(reply);
    const access = await getConferenceAccess(db, doc.conference_id, req.user!.id);
    if (!access) return notFound(reply);
    if (!access.canManage) return reply.code(403).send({ error: 'forbidden', message: 'Bạn không có quyền xóa tài liệu.' });
    await db.query('DELETE FROM documents WHERE id = $1', [id]);
    await audit(db, { workspaceId: access.conference.workspace_id, userId: req.user!.id, action: 'document.delete', targetType: 'document', targetId: id, meta: { filename: doc.filename } });
    return { ok: true };
  });
}
