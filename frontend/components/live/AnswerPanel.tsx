'use client';

import { useState } from 'react';
import type { AnswerOption, QuestionDto, ResponseMode, StructuredAnswer } from '@conference-copilot/shared';
import { Badge, Button, Spinner, inputClass } from '@/components/ui';
import type { QuestionsState } from './useQuestions';

const MODE_LABEL: Record<ResponseMode, string> = {
  professional: 'Chuyên nghiệp',
  concise: 'Ngắn gọn',
  strategic: 'Chiến lược',
  academic: 'Học thuật',
  technical: 'Chuyên sâu',
};

const STATUS: Record<QuestionDto['status'], { label: string; tone: 'default' | 'live' | 'ok' | 'warn' | 'cyan' }> = {
  detected: { label: 'Đã phát hiện', tone: 'cyan' },
  answering: { label: 'Đang soạn', tone: 'cyan' },
  answered: { label: 'Đã có gợi ý', tone: 'ok' },
  error: { label: 'Lỗi', tone: 'live' },
  awaiting_click: { label: 'Chờ bấm', tone: 'warn' },
};

const CONTEXT_NOTE: Record<StructuredAnswer['context'], string | null> = {
  all: null,
  ranked: null,
  none: 'Hội nghị chưa có tài liệu: câu trả lời không dựa trên tài liệu của bạn.',
  no_match: 'Không tìm thấy đoạn tài liệu liên quan: hãy kiểm tra kỹ trước khi dùng.',
};

/** The streamed text is the model's marker format; show it as readable progress while it arrives. */
function cleanDraft(raw: string) {
  return raw
    .replace(/\[\[OPTION (\w+)\]\]/g, (_, m: string) => `\n— ${MODE_LABEL[m as ResponseMode] ?? m} —\n`)
    .replace(/\[\[(ANALYSIS|VI|EN|MISSING|FOLLOWUP)\]\]/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(-600);
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="rounded px-1.5 py-0.5 text-[11px] text-faint hover:bg-panel-2 hover:text-fg"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => {},
        )
      }
    >
      {done ? 'Đã chép' : 'Chép'}
    </button>
  );
}

function OptionView({ option }: { option: AnswerOption }) {
  return (
    <div className="space-y-2 rounded-lg border border-line bg-navy/50 p-3">
      <div className="text-[11px] font-medium tracking-wide text-cyan uppercase">{MODE_LABEL[option.mode] ?? option.mode}</div>
      <div>
        <div className="flex items-center justify-between text-[11px] text-faint">
          <span>Tiếng Việt</span>
          <CopyButton text={option.vi} />
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-line">{option.vi}</p>
      </div>
      <div>
        <div className="flex items-center justify-between text-[11px] text-faint">
          <span>English (để nói)</span>
          <CopyButton text={option.en} />
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-line text-fg/90">{option.en}</p>
      </div>
      {option.citations.length > 0 && (
        <ul className="space-y-1.5 border-t border-line pt-2">
          {option.citations.map((c) => (
            <li key={`${c.chunk_id}-${c.quote.slice(0, 20)}`} className="text-[11px] text-faint">
              <span className="font-medium text-muted">
                {c.filename} · {c.locator}
              </span>
              {c.quote && <blockquote className="mt-0.5 border-l-2 border-line-strong pl-2 italic">“{c.quote}”</blockquote>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QuestionCard({ q, draft, onAnswer }: { q: QuestionDto; draft: string | undefined; onAnswer: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[q.status];
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(q.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không gửi được yêu cầu');
    } finally {
      setBusy(false);
    }
  };
  const a = q.answer;
  const note = a ? CONTEXT_NOTE[a.context] : null;

  return (
    <li className="space-y-2 rounded-xl border border-line-strong bg-panel p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{q.text_vi || q.text_original}</p>
          {q.text_vi && q.text_vi !== q.text_original && <p className="mt-0.5 text-xs text-faint">{q.text_original}</p>}
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      {q.status === 'answering' && (
        <div className="rounded-lg bg-navy/50 p-2 text-xs whitespace-pre-line text-muted">
          {draft ? (
            cleanDraft(draft)
          ) : (
            <span className="flex items-center gap-2">
              <Spinner /> Đang tìm trong tài liệu và soạn trả lời…
            </span>
          )}
        </div>
      )}

      {q.status === 'error' && q.error && <p className="text-xs text-live">{q.error}</p>}
      {q.status === 'awaiting_click' && <p className="text-xs text-faint">Đã dùng hết ngân sách gợi ý tự động của hội nghị: bấm để soạn thủ công.</p>}

      {a && q.status === 'answered' && (
        <div className="space-y-2">
          {note && <p className="rounded-md border border-warn/30 bg-warn/10 px-2 py-1 text-[11px] text-warn">{note}</p>}
          {a.analysis_vi && <p className="text-xs leading-relaxed text-muted">{a.analysis_vi}</p>}
          {a.options.map((o) => (
            <OptionView key={o.mode} option={o} />
          ))}
          {a.missing && a.missing !== 'Không có' && (
            <p className="text-[11px] text-faint">
              <span className="font-medium text-muted">Còn thiếu: </span>
              {a.missing}
            </p>
          )}
          {a.follow_ups.length > 0 && (
            <div className="text-[11px] text-faint">
              <div className="font-medium text-muted">Có thể hỏi lại:</div>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                {a.follow_ups.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {(q.status === 'awaiting_click' || q.status === 'error' || q.status === 'answered' || q.status === 'detected') && (
        <div className="flex items-center gap-2">
          <Button variant={q.status === 'answered' ? 'subtle' : 'primary'} onClick={run} loading={busy}>
            {q.status === 'answered' ? 'Soạn lại' : 'Soạn gợi ý'}
          </Button>
          {error && <span className="text-xs text-live">{error}</span>}
        </div>
      )}
    </li>
  );
}

/** Suggested answers to questions asked in the room, grounded in the conference's documents. */
export function AnswerPanel({ questions, configured }: { questions: QuestionsState; configured: boolean }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const t = text.trim();
    if (t.length < 3) return;
    setSending(true);
    setError(null);
    try {
      await questions.ask({ text: t });
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không gửi được câu hỏi');
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs font-medium tracking-[0.18em] text-faint uppercase">
        <span>Gợi ý trả lời</span>
        {questions.budget && questions.budget.autoBudgetUsd > 0 && (
          <span className="tracking-normal normal-case" title="Chi phí gợi ý trả lời đã dùng / ngân sách tự động của hội nghị">
            ${questions.budget.spentUsd.toFixed(2)} / ${questions.budget.autoBudgetUsd.toFixed(2)}
          </span>
        )}
      </div>
      {!configured ? (
        <p className="text-xs text-faint">Cần cấu hình ANTHROPIC_API_KEY trong backend/.env để phát hiện câu hỏi và gợi ý trả lời.</p>
      ) : (
        <>
          <p className="mb-2 text-xs text-faint">Câu hỏi trong phòng được tự phát hiện. Bạn cũng có thể tự hỏi, hoặc bấm “Gợi ý” trên một câu dịch.</p>
          <div className="flex gap-2">
            <input
              className={inputClass}
              placeholder="Nhập câu hỏi cần gợi ý trả lời…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              aria-label="Câu hỏi cần gợi ý trả lời"
            />
            <Button onClick={submit} loading={sending} disabled={text.trim().length < 3}>
              Hỏi
            </Button>
          </div>
          {error && <p className="mt-1 text-xs text-live">{error}</p>}
        </>
      )}
      {questions.questions.length > 0 && (
        <ul className="mt-3 space-y-3">
          {questions.questions.map((q) => (
            <QuestionCard key={q.id} q={q} draft={questions.drafts[q.id]} onAnswer={questions.answer} />
          ))}
        </ul>
      )}
    </div>
  );
}
