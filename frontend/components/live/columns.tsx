'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Segment, type Usage } from '@/lib/api';
import { inputClass } from '@/components/ui';
import { AnswerPanel } from './AnswerPanel';
import { KnowledgePanel } from './KnowledgePanel';
import { JumpToLatest, LangBadge, useAutoScroll } from './parts';
import { OriginalRow, TranslationRow } from './rows';
import type { PartialLine } from './useLiveSession';
import type { QuestionsState } from './useQuestions';

/** The three columns of the live page: original transcript, Vietnamese translation, session tools. */

function ColumnHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
      <h2 className="text-xs font-medium tracking-[0.18em] text-faint uppercase">{title}</h2>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

export function OriginalColumn({ hidden, segments, partial, canEdit, historySeq, onSave }: { hidden: boolean; segments: Segment[]; partial: PartialLine | null; canEdit: boolean; historySeq: number; onSave: (id: string, text: string) => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const { atBottom, jump } = useAutoScroll(ref, `${segments.length}:${partial?.text}`);
  return (
    <section className={`relative min-h-0 flex-col border-r border-line ${hidden ? 'hidden lg:flex' : 'flex'}`}>
      <ColumnHeader title="Original Transcript">{partial?.language && <LangBadge code={partial.language} />}</ColumnHeader>
      <div ref={ref} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {segments.length === 0 && !partial && <EmptyState text="Nội dung gốc sẽ xuất hiện ở đây ngay khi diễn giả bắt đầu nói." />}
        {segments.map((s) => (
          <OriginalRow key={s.id} segment={s} canEdit={canEdit} animate={s.seq > historySeq} onSave={onSave} />
        ))}
        {partial && (
          <div aria-live="polite">
            <div className="mb-1.5 font-mono text-[11px] text-faint">{partial.speaker ?? 'Đang nghe'} · tạm thời</div>
            <p className="text-[15px] leading-relaxed text-faint italic">{partial.text}</p>
          </div>
        )}
      </div>
      <JumpToLatest show={!atBottom} onClick={jump} />
    </section>
  );
}

export function TranslationColumn(props: {
  hidden: boolean;
  segments: Segment[];
  drafts: Record<string, string>;
  partial: PartialLine | null;
  fontSize: number;
  setFontSize: (n: number) => void;
  bigMode: boolean;
  setBigMode: (b: boolean) => void;
  canEdit: boolean;
  flashId: string | null;
  historySeq: number;
  live: boolean;
  onSave: (id: string, text: string) => Promise<void>;
  onRetranslate: (id: string) => void;
  onToggleImportant: (s: Segment) => void;
  onAsk?: (segmentId: string) => void;
  fullscreen: { supported: boolean; isFullscreen: boolean; toggle: () => Promise<void> };
  wakeLockHeld: boolean;
}) {
  const { segments, drafts, fontSize, setFontSize, bigMode, setBigMode, fullscreen } = props;
  const ref = useRef<HTMLDivElement>(null);
  const draftLen = Object.values(drafts).reduce((n, d) => n + d.length, 0);
  const { atBottom, jump } = useAutoScroll(ref, `${segments.length}:${draftLen}:${segments.at(-1)?.text_vi?.length}`);
  return (
    <section className={`relative min-h-0 flex-col bg-navy/30 ${props.hidden ? 'hidden lg:flex' : 'flex'}`}>
      <ColumnHeader title="Bản dịch tiếng Việt">
        <button type="button" onClick={() => setFontSize(Math.max(14, fontSize - 2))} className="rounded-md px-2 py-1 text-sm text-muted hover:bg-panel-2 hover:text-fg" aria-label="Giảm cỡ chữ">A−</button>
        <span className="w-8 text-center font-mono text-[11px] text-faint">{fontSize}</span>
        <button type="button" onClick={() => setFontSize(Math.min(48, fontSize + 2))} className="rounded-md px-2 py-1 text-base text-muted hover:bg-panel-2 hover:text-fg" aria-label="Tăng cỡ chữ">A+</button>
        <button type="button" onClick={() => setBigMode(!bigMode)} className={`ml-1 rounded-md border px-2.5 py-1 text-xs ${bigMode ? 'border-electric bg-electric/15 text-fg' : 'border-line-strong text-muted hover:text-fg'}`}>
          {bigMode ? 'Thoát chữ lớn' : 'Chế độ chữ lớn'}
        </button>
        {fullscreen.supported && (
          <button type="button"
            onClick={() => void fullscreen.toggle()}
            className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-muted hover:text-fg"
            aria-label={fullscreen.isFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
            title={props.wakeLockHeld ? 'Màn hình đang được giữ sáng' : undefined}
          >
            {fullscreen.isFullscreen ? 'Thoát ⛶' : '⛶'}
          </button>
        )}
      </ColumnHeader>
      <div ref={ref} className={`min-h-0 flex-1 overflow-y-auto py-5 ${bigMode ? 'mx-auto w-full max-w-5xl px-6' : 'px-6'}`}>
        {segments.length === 0 && <EmptyState text="Bản dịch tiếng Việt sẽ hiện ra liên tục, thường chỉ sau khoảng 1–2 giây." />}
        <div className="space-y-5" style={{ fontSize, lineHeight: 1.55 }}>
          {segments.map((s) => (
            <TranslationRow
              key={s.id}
              segment={s}
              draft={drafts[s.id]}
              canEdit={props.canEdit}
              bigMode={bigMode}
              flash={props.flashId === s.id}
              animate={s.seq > props.historySeq}
              onSave={props.onSave}
              onRetranslate={props.onRetranslate}
              onToggleImportant={props.onToggleImportant}
              onAsk={props.onAsk}
            />
          ))}
          {props.partial && props.live && (
            <p className="flex items-center gap-2 pl-4 text-[0.7em] text-faint">
              <span className="flex gap-1">{[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-pulse rounded-full bg-electric" style={{ animationDelay: `${i * 150}ms` }} />)}</span>
              Đang nghe diễn giả…
            </p>
          )}
        </div>
      </div>
      <JumpToLatest show={!atBottom} onClick={jump} />
    </section>
  );
}

export function ToolsColumn({
  hidden,
  conferenceId,
  segments,
  avgLatency,
  usage,
  onFocus,
  questions,
  answersConfigured,
  canManage,
}: {
  hidden: boolean;
  conferenceId: string;
  segments: Segment[];
  avgLatency: number | null;
  usage: Usage | null;
  onFocus: (id: string) => void;
  questions: QuestionsState;
  answersConfigured: boolean;
  canManage: boolean;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Segment[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const important = useMemo(() => segments.filter((s) => s.is_important), [segments]);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      api<{ segments: Segment[] }>(`/api/conferences/${conferenceId}/segments?q=${encodeURIComponent(term)}`)
        .then((r) => setResults(r.segments))
        .catch((e) => setSearchError(e.message))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q, conferenceId]);

  const translated = segments.filter((s) => s.text_vi).length;

  return (
    <aside className={`min-h-0 flex-col overflow-y-auto border-l border-line ${hidden ? 'hidden lg:flex' : 'flex'}`}>
      <ColumnHeader title="Công cụ phiên" />
      <div className="space-y-6 p-5">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Đoạn đã ghi" value={segments.length} />
          <Stat label="Đã dịch" value={`${translated}/${segments.length}`} />
          <Stat label="Độ trễ dịch TB" value={avgLatency === null ? '—' : `${(avgLatency / 1000).toFixed(1)}s`} hint="Từ lúc câu được chốt đến khi dịch xong" />
          <Stat label="Chi phí ước tính" value={usage ? `$${usage.totalUsd.toFixed(3)}` : '—'} hint="STT + dịch, theo đơn giá trong .env" />
        </div>

        <div>
          <div className="mb-2 text-xs font-medium tracking-[0.18em] text-faint uppercase">Tìm trong transcript</div>
          <input className={inputClass} placeholder="Từ khóa (gốc hoặc tiếng Việt)…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm trong transcript" />
          {searching && <div className="mt-2 text-xs text-faint">Đang tìm…</div>}
          {searchError && <div className="mt-2 text-xs text-live">{searchError}</div>}
          {results && !searching && (
            <ul className="mt-2 space-y-1">
              {results.length === 0 && <li className="text-xs text-faint">Không có kết quả.</li>}
              {results.slice(0, 30).map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onFocus(s.id)} className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-muted hover:bg-panel-2 hover:text-fg">
                    <span className="mr-2 font-mono text-[11px] text-faint">#{s.seq}</span>
                    <span className="line-clamp-2">{s.text_vi || s.text_original}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-xs font-medium tracking-[0.18em] text-faint uppercase">
            <span>Nội dung quan trọng</span>
            <span className="text-cyan">{important.length}</span>
          </div>
          {important.length === 0 ? (
            <p className="text-xs text-faint">Rê chuột vào một câu dịch và bấm ★ để đánh dấu. Các câu được đánh dấu sẽ có ★ khi xuất file.</p>
          ) : (
            <ul className="space-y-1">
              {important.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onFocus(s.id)} className="w-full rounded-lg border-l-2 border-cyan px-3 py-1.5 text-left text-sm text-muted hover:bg-panel-2 hover:text-fg">
                    <span className="line-clamp-3">{s.text_vi || s.text_original}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <AnswerPanel questions={questions} configured={answersConfigured} />

        <KnowledgePanel conferenceId={conferenceId} canManage={canManage} />
      </div>
    </aside>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-navy/50 p-3" title={hint}>
      <div className="text-[11px] text-faint">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="grid h-full min-h-40 place-items-center px-6 text-center text-sm text-faint">{text}</div>;
}
