'use client';

import { useRef, useState } from 'react';
import {
  api,
  RESPONSE_MODE_LABELS,
  type Conference,
  type KbDocument,
  type Question,
  type ResponseMode,
  type Segment,
  type StructuredAnswer,
} from '@/lib/api';
import { Badge, Button, Dialog, Spinner, inputClass } from '@/components/ui';
import { speaker } from '@/lib/tts';

const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.csv';
const DEFAULT_MODES: ResponseMode[] = ['professional', 'concise', 'strategic'];

/** Readable preview of the answer while it streams: markers become short labels. */
function streamingPreview(raw: string) {
  return raw
    .replace(/^\[\[ANALYSIS\]\]\s*$/gm, '— Phân tích —')
    .replace(/^\[\[OPTION\s+([a-z]+)\]\]\s*$/gm, (_, m: string) => `— ${RESPONSE_MODE_LABELS[m as ResponseMode] ?? m} —`)
    .replace(/^\[\[(VI|EN)\]\]\s*$/gm, (_, l: string) => `[${l}]`)
    .replace(/^\[\[MISSING\]\]\s*$/gm, '— Tài liệu còn thiếu —')
    .replace(/^\[\[FOLLOWUP\]\]\s*$/gm, '— Câu hỏi lại —');
}

export function AssistantPanel(props: {
  conference: Conference;
  canManage: boolean;
  documents: KbDocument[];
  setDocuments: (fn: (d: KbDocument[]) => KbDocument[]) => void;
  questions: Question[];
  answerDrafts: Record<string, string>;
  segments: Segment[];
  onConferenceChange: (c: Conference) => void;
  toast: (msg: string) => void;
}) {
  const { conference, canManage, documents, questions, answerDrafts, segments, toast } = props;
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [zoomId, setZoomId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const modes = conference.response_modes?.length ? conference.response_modes : DEFAULT_MODES;
  const readyDocs = documents.filter((d) => d.status === 'ready').length;
  const lastSegment = segments.at(-1);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadError(null);
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        const body = new FormData();
        body.append('file', file);
        const { document } = await api<{ document: KbDocument }>(`/api/conferences/${conference.id}/documents`, { method: 'POST', body });
        props.setDocuments((d) => [...d.filter((x) => x.id !== document.id), document]);
        if (document.status === 'error') setUploadError(`${file.name}: ${document.error ?? 'không đọc được'}`);
      } catch (err) {
        setUploadError(`${file.name}: ${err instanceof Error ? err.message : 'tải lên thất bại'}`);
      }
    }
    setUploading(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const remove = async (doc: KbDocument) => {
    if (!window.confirm(`Xóa tài liệu “${doc.filename}”?`)) return;
    try {
      await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
      props.setDocuments((d) => d.filter((x) => x.id !== doc.id));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không xóa được');
    }
  };

  const ask = async (payload: { text: string } | { segmentId: string }) => {
    setAsking(true);
    setAskError(null);
    try {
      await api(`/api/conferences/${conference.id}/questions`, { method: 'POST', json: payload });
      if ('text' in payload) setText('');
    } catch (err) {
      setAskError(err instanceof Error ? err.message : 'Không gửi được câu hỏi');
    } finally {
      setAsking(false);
    }
  };

  const reanswer = async (q: Question) => {
    try {
      await api(`/api/questions/${q.id}/answer`, { method: 'POST' });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không soạn lại được');
    }
  };

  const toggleMode = async (m: ResponseMode) => {
    const next = modes.includes(m) ? modes.filter((x) => x !== m) : [...modes, m];
    if (next.length === 0) return toast('Cần giữ ít nhất 1 kiểu trả lời');
    if (next.length > 3) return toast('Tối đa 3 kiểu trả lời');
    try {
      const { conference: c } = await api<{ conference: Conference }>(`/api/conferences/${conference.id}`, { method: 'PATCH', json: { response_modes: next } });
      props.onConferenceChange(c);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không lưu được');
    }
  };

  const zoomed = questions.find((q) => q.id === zoomId) ?? null;

  return (
    <div className="space-y-5">
      {/* Knowledge base */}
      <div>
        <div className="mb-2 flex items-center justify-between text-xs font-medium tracking-[0.18em] text-faint uppercase">
          <span>Tài liệu của bạn</span>
          <span className={readyDocs ? 'text-ok' : 'text-warn'}>{readyDocs} sẵn sàng</span>
        </div>
        {documents.length === 0 && (
          <p className="mb-2 text-xs leading-relaxed text-faint">
            Tải lên báo cáo, slide, bảng tính của bạn. Gợi ý trả lời chỉ lấy số liệu và lập luận từ đây, kèm trang/slide để bạn đối chiếu.
          </p>
        )}
        <ul className="space-y-1.5">
          {documents.map((d) => (
            <li key={d.id} className="rounded-lg border border-line bg-navy/50 px-3 py-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words">{d.filename}</span>
                {canManage && (
                  <button onClick={() => remove(d)} className="shrink-0 text-xs text-faint hover:text-live" aria-label={`Xóa ${d.filename}`}>
                    Xóa
                  </button>
                )}
              </div>
              <div className="mt-1 text-[11px] text-faint">
                {d.status === 'ready' && <span className="text-ok">✓ {d.unit_count} {d.kind === 'pptx' ? 'slide' : d.kind === 'xlsx' ? 'sheet' : 'trang'} · {Math.round(d.char_count / 1000)}k ký tự</span>}
                {d.status === 'processing' && 'Đang đọc…'}
                {d.status === 'error' && <span className="text-live">{d.error}</span>}
                {d.warning && d.status === 'ready' && <span className="block text-warn">{d.warning}</span>}
              </div>
            </li>
          ))}
        </ul>
        {canManage && (
          <>
            <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => void upload(e.target.files)} />
            <Button className="mt-2 w-full" onClick={() => fileRef.current?.click()} loading={Boolean(uploading)}>
              {uploading ? `Đang đọc ${uploading}…` : 'Tải tài liệu lên (PDF, DOCX, PPTX, XLSX, CSV)'}
            </Button>
          </>
        )}
        {uploadError && <p className="mt-2 text-xs text-live">{uploadError}</p>}
      </div>

      {/* Response styles */}
      <div>
        <div className="mb-2 text-xs font-medium tracking-[0.18em] text-faint uppercase">Kiểu gợi ý (tối đa 3)</div>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(RESPONSE_MODE_LABELS) as ResponseMode[]).map((m) => (
            <button
              key={m}
              disabled={!canManage}
              onClick={() => void toggleMode(m)}
              className={`rounded-full border px-2.5 py-1 text-xs ${modes.includes(m) ? 'border-electric bg-electric/15 text-fg' : 'border-line-strong text-muted hover:text-fg'} disabled:cursor-default`}
            >
              {RESPONSE_MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Ask */}
      <div>
        <div className="mb-2 text-xs font-medium tracking-[0.18em] text-faint uppercase">Hỏi trợ lý</div>
        {lastSegment && (
          <Button className="mb-2 w-full" variant="primary" loading={asking} onClick={() => void ask({ segmentId: lastSegment.id })} title={lastSegment.text_original}>
            Gợi ý cho câu vừa nghe
          </Button>
        )}
        <textarea
          className={`${inputClass} min-h-20 resize-y`}
          placeholder="Gõ hoặc dán câu hỏi của giám khảo (tiếng Anh hoặc tiếng Việt)…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim().length >= 3) void ask({ text: text.trim() });
          }}
          aria-label="Câu hỏi"
        />
        <Button className="mt-2 w-full" onClick={() => void ask({ text: text.trim() })} disabled={text.trim().length < 3} loading={asking}>
          Gợi ý trả lời (Ctrl+Enter)
        </Button>
        {askError && <p className="mt-2 text-xs text-live">{askError}</p>}
        {readyDocs === 0 && <p className="mt-2 text-xs text-warn">Chưa có tài liệu nào sẵn sàng: gợi ý sẽ không dựa trên tài liệu của bạn.</p>}
      </div>

      {/* Questions and answers */}
      <div>
        <div className="mb-2 flex items-center justify-between text-xs font-medium tracking-[0.18em] text-faint uppercase">
          <span>Câu hỏi &amp; gợi ý</span>
          <span className="text-cyan">{questions.length}</span>
        </div>
        {questions.length === 0 && <p className="text-xs leading-relaxed text-faint">Khi đang nghe, câu hỏi của giám khảo được tự phát hiện và gợi ý trả lời hiện ở đây.</p>}
        <ul className="space-y-3">
          {questions.map((q) => (
            <li key={q.id}>
              <QuestionCard q={q} draft={answerDrafts[q.id]} onZoom={() => setZoomId(q.id)} onReanswer={() => void reanswer(q)} />
            </li>
          ))}
        </ul>
      </div>

      <Dialog open={Boolean(zoomed)} onClose={() => setZoomId(null)} title="Gợi ý trả lời" wide>
        {zoomed && <QuestionCard q={zoomed} draft={answerDrafts[zoomed.id]} big onReanswer={() => void reanswer(zoomed)} />}
      </Dialog>
    </div>
  );
}

function QuestionCard({ q, draft, big, onZoom, onReanswer }: { q: Question; draft?: string; big?: boolean; onZoom?: () => void; onReanswer: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-navy/50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`font-medium ${big ? 'text-lg' : 'text-sm'}`}>{q.text_original}</p>
          {q.text_vi && q.text_vi !== q.text_original && <p className="mt-0.5 text-xs text-muted">{q.text_vi}</p>}
        </div>
        {onZoom && q.answer && (
          <button onClick={onZoom} className="shrink-0 rounded-md border border-line-strong px-2 py-0.5 text-xs text-muted hover:text-fg">
            Phóng to
          </button>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {q.source === 'auto' ? <Badge tone="cyan">Tự phát hiện</Badge> : <Badge>Hỏi tay</Badge>}
        {(q.status === 'detected' || q.status === 'answering') && (
          <Badge tone="warn">
            <Spinner className="size-2.5" /> Đang soạn…
          </Badge>
        )}
      </div>

      {q.status === 'answering' && draft && (
        <pre className="mt-2 max-h-60 overflow-y-auto font-sans text-xs leading-relaxed whitespace-pre-wrap text-muted">{streamingPreview(draft)}</pre>
      )}
      {q.status === 'error' && (
        <div className="mt-2 text-xs text-live">
          {q.error}{' '}
          <button onClick={onReanswer} className="font-medium text-fg underline">Thử lại</button>
        </div>
      )}
      {q.status === 'awaiting_click' && (
        <Button className="mt-2 w-full" onClick={onReanswer}>Đã hết ngân sách tự động. Bấm để soạn gợi ý</Button>
      )}
      {q.status === 'answered' && q.answer && <AnswerView answer={q.answer} big={big} onReanswer={onReanswer} />}
    </div>
  );
}

function AnswerView({ answer, big, onReanswer }: { answer: StructuredAnswer; big?: boolean; onReanswer: () => void }) {
  const [active, setActive] = useState(0);
  const [openQuote, setOpenQuote] = useState<number | null>(null);
  const option = answer.options[Math.min(active, answer.options.length - 1)];

  return (
    <div className="mt-2 space-y-2.5">
      {answer.context === 'none' && (
        <div className="rounded-lg border border-live/40 bg-live/10 px-2.5 py-1.5 text-xs text-[#ffb3c0]">
          Không có tài liệu: câu trả lời này KHÔNG dựa trên tài liệu của bạn. Đừng dùng số liệu trong đó.
        </div>
      )}
      {answer.context === 'no_match' && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
          Không tìm thấy đoạn liên quan trong tài liệu. Hãy trả lời thận trọng.
        </div>
      )}
      {answer.analysis_vi && <p className="text-xs leading-relaxed text-muted">💡 {answer.analysis_vi}</p>}

      {answer.options.length > 1 && (
        <div className="flex flex-wrap gap-1" role="tablist">
          {answer.options.map((o, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === active}
              onClick={() => { setActive(i); setOpenQuote(null); }}
              className={`rounded-md px-2 py-0.5 text-xs ${i === active ? 'bg-electric/20 text-fg' : 'text-muted hover:text-fg'}`}
            >
              {RESPONSE_MODE_LABELS[o.mode] ?? o.mode}
            </button>
          ))}
        </div>
      )}

      {option && (
        <div>
          {option.en && <p className={`leading-relaxed text-fg ${big ? 'text-2xl' : 'text-[15px]'}`}>{option.en}</p>}
          {option.vi && <p className={`mt-1.5 leading-relaxed text-muted ${big ? 'text-base' : 'text-xs'}`}>{option.vi}</p>}
          {option.vi && speaker.supported && (
            <button onClick={() => speaker.say(option.vi, { interrupt: true })} className="mt-1 text-[11px] text-cyan hover:text-fg">
              🔊 Nghe bản tiếng Việt
            </button>
          )}
          <div className="mt-2">
            {option.citations.length === 0 ? (
              <Badge tone="warn">Không có trích dẫn: kiểm tra lại trước khi nói</Badge>
            ) : (
              <div className="flex flex-wrap gap-1">
                {option.citations.map((c, i) => (
                  <button
                    key={`${c.chunk_id}-${i}`}
                    onClick={() => setOpenQuote(openQuote === i ? null : i)}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${openQuote === i ? 'border-ok bg-ok/15 text-fg' : 'border-ok/30 text-ok hover:bg-ok/10'}`}
                    title={c.quote}
                  >
                    📄 {c.filename.replace(/\.[a-z]+$/i, '')} · {c.locator}
                  </button>
                ))}
              </div>
            )}
            {openQuote !== null && option.citations[openQuote] && (
              <blockquote className="mt-1.5 border-l-2 border-ok/50 pl-2.5 text-xs leading-relaxed text-muted italic">
                “{option.citations[openQuote].quote}”
              </blockquote>
            )}
          </div>
        </div>
      )}

      {answer.missing && <p className="text-xs leading-relaxed text-warn">⚠ Tài liệu chưa có: {answer.missing}</p>}
      {answer.follow_ups.length > 0 && (
        <div className="text-xs text-muted">
          <div className="text-faint">Có thể hỏi lại:</div>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
            {answer.follow_ups.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      )}
      <button onClick={onReanswer} className="text-[11px] text-faint hover:text-fg">↻ Soạn lại</button>
    </div>
  );
}
