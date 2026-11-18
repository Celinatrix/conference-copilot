'use client';

import { useRef, useState } from 'react';
import {
  ANSWER_MODELS,
  api,
  DEFAULT_ANSWER_MODEL,
  modelLabel,
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

  const reanswer = async (q: Question, correctedText?: string, quality = false) => {
    try {
      const text = correctedText?.trim();
      const body = { ...(text && text !== q.text_original ? { text } : {}), ...(quality ? { quality: true } : {}) };
      await api(`/api/questions/${q.id}/answer`, { method: 'POST', ...(Object.keys(body).length ? { json: body } : {}) });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không soạn lại được');
    }
  };

  const dismiss = async (q: Question) => {
    try {
      await api(`/api/questions/${q.id}/dismiss`, { method: 'POST' });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không bỏ qua được');
    }
  };

  // Questions waiting for confirmation come first: they block an answer until the listener acts.
  const visible = questions
    .filter((q) => q.status !== 'dismissed')
    .sort((a, b) => Number(b.status === 'awaiting_confirm') - Number(a.status === 'awaiting_confirm'));

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

  const answerModel = conference.answer_model ?? DEFAULT_ANSWER_MODEL;
  const chooseModel = async (id: string) => {
    if (id === answerModel) return;
    try {
      const { conference: c } = await api<{ conference: Conference }>(`/api/conferences/${conference.id}`, {
        method: 'PATCH',
        json: { answer_model: id === DEFAULT_ANSWER_MODEL ? null : id },
      });
      props.onConferenceChange(c);
      toast(`Gợi ý tiếp theo sẽ soạn bằng ${ANSWER_MODELS.find((m) => m.id === id)?.name ?? id}`);
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

      {/* Answer model */}
      <div>
        <div className="mb-2 text-xs font-medium tracking-[0.18em] text-faint uppercase">Model soạn gợi ý</div>
        <div className="grid gap-1.5" role="radiogroup" aria-label="Model soạn gợi ý">
          {ANSWER_MODELS.map((m) => {
            const selected = m.id === answerModel;
            return (
              <button
                key={m.id}
                role="radio"
                aria-checked={selected}
                disabled={!canManage}
                onClick={() => void chooseModel(m.id)}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left disabled:cursor-default ${
                  selected ? 'border-electric bg-electric/15' : 'border-line-strong hover:border-electric/50'
                }`}
              >
                <span className={`grid size-4 shrink-0 place-items-center rounded-full border ${selected ? 'border-electric' : 'border-line-strong'}`}>
                  {selected && <span className="size-2 rounded-full bg-electric" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{m.name}</span>
                  <span className="block text-[11px] text-faint">{m.note}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted">{m.cost}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-faint">Áp dụng cho câu hỏi tiếp theo, kể cả khi đang nghe. Câu soạn bằng Haiku vẫn có nút “Soạn kỹ hơn (Sonnet)”.</p>
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
          <span className="text-cyan">{visible.length}</span>
        </div>
        {visible.length === 0 && <p className="text-xs leading-relaxed text-faint">Khi đang nghe, câu hỏi của giám khảo được tự phát hiện và gợi ý trả lời hiện ở đây.</p>}
        <ul className="space-y-3">
          {visible.map((q) => (
            <li key={q.id}>
              {q.status === 'awaiting_confirm' ? (
                <ConfirmCard q={q} onConfirm={(text) => void reanswer(q, text)} onDismiss={() => void dismiss(q)} />
              ) : (
                <QuestionCard
                  q={q}
                  draft={answerDrafts[q.id]}
                  onZoom={() => setZoomId(q.id)}
                  onReanswer={() => void reanswer(q)}
                  onUpgrade={() => void reanswer(q, undefined, true)}
                  onDismiss={() => void dismiss(q)}
                />
              )}
            </li>
          ))}
        </ul>
      </div>

      <Dialog open={Boolean(zoomed)} onClose={() => setZoomId(null)} title="Gợi ý trả lời" wide>
        {zoomed && (
          <QuestionCard
            q={zoomed}
            draft={answerDrafts[zoomed.id]}
            big
            onReanswer={() => void reanswer(zoomed)}
            onUpgrade={() => void reanswer(zoomed, undefined, true)}
          />
        )}
      </Dialog>
    </div>
  );
}

/** "X": removes a question from the list for everyone following the conference. */
function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Xoá câu hỏi này khỏi danh sách"
      title="Xoá câu hỏi này"
      className="grid size-6 place-items-center rounded-md border border-line-strong text-muted hover:border-live/60 hover:bg-live/10 hover:text-live"
    >
      <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

/** A question heard unclearly: the listener checks (and may correct) the text before any answer is drafted. */
function ConfirmCard({ q, onConfirm, onDismiss }: { q: Question; onConfirm: (text: string) => void; onDismiss: () => void }) {
  const [text, setText] = useState(q.text_original);
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-xl border-2 border-warn/60 bg-warn/10 p-3" role="alert">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-warn">⚠ Nghe chưa rõ câu hỏi, hãy xác nhận</div>
        <DismissButton onClick={onDismiss} />
      </div>
      {q.unclear_reason && <p className="mt-1 text-xs text-muted">{q.unclear_reason}</p>}
      {q.text_vi && <p className="mt-1.5 text-xs text-muted">Bản dịch app nghe được: {q.text_vi}</p>}
      <textarea
        className={`${inputClass} mt-2 min-h-16 resize-y`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim().length >= 3) {
            setBusy(true);
            onConfirm(text);
          }
        }}
        aria-label="Câu hỏi (sửa nếu sai)"
      />
      <p className="mt-1 text-[11px] text-faint">Sửa lại câu hỏi nếu app nghe sai, rồi bấm xác nhận.</p>
      <div className="mt-2 flex gap-2">
        <Button
          variant="primary"
          className="flex-1"
          loading={busy}
          disabled={text.trim().length < 3}
          onClick={() => {
            setBusy(true);
            onConfirm(text);
          }}
        >
          Đúng, soạn gợi ý
        </Button>
        <Button onClick={onDismiss}>Bỏ qua</Button>
      </div>
    </div>
  );
}

function QuestionCard({
  q,
  draft,
  big,
  onZoom,
  onReanswer,
  onUpgrade,
  onDismiss,
}: {
  q: Question;
  draft?: string;
  big?: boolean;
  onZoom?: () => void;
  onReanswer: () => void;
  onUpgrade: () => void;
  /** Removes the question from the list (not shown inside the zoom dialog). */
  onDismiss?: () => void;
}) {
  const isQuickDraft = Boolean(q.answer_model?.includes('haiku'));
  return (
    <div className="rounded-xl border border-line bg-navy/50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`font-medium ${big ? 'text-lg' : 'text-sm'}`}>{q.text_original}</p>
          {q.text_vi && q.text_vi !== q.text_original && <p className="mt-0.5 text-xs text-muted">{q.text_vi}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onZoom && q.answer && (
            <button onClick={onZoom} className="rounded-md border border-line-strong px-2 py-0.5 text-xs text-muted hover:text-fg">
              Phóng to
            </button>
          )}
          {onDismiss && <DismissButton onClick={onDismiss} />}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {q.source === 'auto' ? <Badge tone="cyan">Tự phát hiện</Badge> : <Badge>Hỏi tay</Badge>}
        {q.status === 'answered' && q.answer_model && <Badge tone={isQuickDraft ? 'default' : 'ok'}>{modelLabel(q.answer_model)}</Badge>}
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
      {q.status === 'answered' && isQuickDraft && (
        <Button className="mt-2 w-full" onClick={onUpgrade} title="Soạn lại bằng Sonnet: lập luận chặt hơn, tốn khoảng 20 lần phí của bản nháp">
          ✨ Soạn kỹ hơn (Sonnet)
        </Button>
      )}
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
