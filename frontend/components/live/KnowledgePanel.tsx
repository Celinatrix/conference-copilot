'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentDto } from '@conference-copilot/shared';
import { api } from '@/lib/api';
import { Badge, Button, Spinner } from '@/components/ui';

const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.csv';
const UNIT: Record<DocumentDto['kind'], string> = { pdf: 'trang', docx: 'phần', pptx: 'slide', xlsx: 'sheet', csv: 'bảng' };

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** The conference's knowledge base: documents suggested answers are grounded in (and cite). */
export function KnowledgePanel({ conferenceId, canManage }: { conferenceId: string; canManage: boolean }) {
  const [docs, setDocs] = useState<DocumentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<{ documents: DocumentDto[] }>(`/api/conferences/${conferenceId}/documents`)
      .then((r) => setDocs(r.documents))
      .catch((e) => setError(e.message));
  }, [conferenceId]);

  useEffect(load, [load]);

  const upload = async (file: File) => {
    setError(null);
    setUploading(file.name);
    try {
      const form = new FormData();
      form.append('file', file);
      // Parsing happens during the request (up to ~30 s for a large file); the reply is the stored document.
      const { document } = await api<{ document: DocumentDto }>(`/api/conferences/${conferenceId}/documents`, { method: 'POST', body: form });
      setDocs((prev) => [...(prev ?? []), document]);
      if (document.status === 'error') setError(document.error ?? 'Không đọc được file.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tải lên thất bại');
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (doc: DocumentDto) => {
    if (!window.confirm(`Xóa "${doc.filename}" khỏi kho tài liệu của hội nghị?`)) return;
    try {
      await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== doc.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không xóa được');
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs font-medium tracking-[0.18em] text-faint uppercase">
        <span>Tài liệu hội nghị</span>
        {docs && <span className="text-cyan">{docs.length}</span>}
      </div>
      <p className="mb-2 text-xs text-faint">Gợi ý trả lời chỉ dựa trên các tài liệu này và trích dẫn vị trí. PDF, DOCX, PPTX, XLSX, CSV, tối đa 25 MB.</p>
      {canManage && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <Button onClick={() => fileRef.current?.click()} loading={Boolean(uploading)} className="w-full">
            {uploading ? `Đang đọc ${uploading}…` : 'Tải tài liệu lên'}
          </Button>
        </>
      )}
      {error && <p className="mt-2 text-xs text-live">{error}</p>}
      {!docs ? (
        !error && (
          <div className="mt-3 flex justify-center text-faint">
            <Spinner />
          </div>
        )
      ) : docs.length === 0 ? (
        <p className="mt-2 text-xs text-faint">Chưa có tài liệu nào.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {docs.map((d) => (
            <li key={d.id} className="group rounded-lg border border-line px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm" title={d.filename}>
                  {d.filename}
                </span>
                {d.status === 'ready' ? <Badge tone="ok">Sẵn sàng</Badge> : d.status === 'error' ? <Badge tone="live">Lỗi</Badge> : <Badge tone="cyan">Đang đọc</Badge>}
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[11px] text-faint">
                <span>
                  {d.kind.toUpperCase()} · {size(d.size_bytes)}
                  {d.status === 'ready' && ` · ${d.unit_count} ${UNIT[d.kind]}`}
                </span>
                {canManage && (
                  <button type="button" onClick={() => void remove(d)} className="text-faint hover:text-live">
                    Xóa
                  </button>
                )}
              </div>
              {(d.warning || (d.status === 'error' && d.error)) && <p className="mt-1 text-[11px] text-warn">{d.status === 'error' ? d.error : d.warning}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
