'use client';

import { memo } from 'react';
import type { Segment } from '@/lib/api';
import { Spinner } from '@/components/ui';
import { EditableText, SegmentMeta, highlightNumbers } from './parts';

/*
 * One row per segment, memoised: a streaming translation delta re-renders only its own row instead of the
 * whole transcript, which is what keeps an 8-hour session responsive. `seg-row` lets the browser skip layout
 * and paint for rows that are off screen.
 */

/** Per-line "X": hides this line from both columns on this device. Always visible on touch screens (no hover). */
export function HideLineButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Ẩn đoạn này khỏi màn hình"
      title="Ẩn đoạn này (không xoá khỏi transcript)"
      className="grid size-5 place-items-center rounded text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-live/10 hover:text-live focus:opacity-100 [@media(hover:none)]:opacity-60"
    >
      <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

export const OriginalRow = memo(function OriginalRow({
  segment,
  canEdit,
  animate,
  onSave,
  onHide,
}: {
  segment: Segment;
  canEdit: boolean;
  animate: boolean;
  onSave: (id: string, text: string) => Promise<void>;
  onHide: (id: string) => void;
}) {
  return (
    <div className={`seg-row group relative ${animate ? 'seg-enter' : ''}`}>
      <div className="absolute top-0 right-0">
        <HideLineButton onClick={() => onHide(segment.id)} />
      </div>
      <SegmentMeta segment={segment} />
      <EditableText value={segment.text_original} canEdit={canEdit} onSave={(v) => onSave(segment.id, v)}>
        <p className="text-[15px] leading-relaxed text-muted">{segment.text_original}</p>
      </EditableText>
    </div>
  );
});

export const TranslationRow = memo(function TranslationRow({
  segment: s,
  draft,
  canEdit,
  bigMode,
  flash,
  animate,
  onSave,
  onRetranslate,
  onToggleImportant,
  onHide,
}: {
  segment: Segment;
  draft: string | undefined;
  canEdit: boolean;
  bigMode: boolean;
  flash: boolean;
  animate: boolean;
  onSave: (id: string, text: string) => Promise<void>;
  onRetranslate: (id: string) => void;
  onToggleImportant: (s: Segment) => void;
  onHide: (id: string) => void;
}) {
  return (
    <div
      id={`vi-${s.id}`}
      className={`seg-row group relative rounded-xl pl-4 transition-colors ${bigMode ? 'pr-8' : ''} ${animate ? 'seg-enter' : ''} ${
        s.is_important ? 'border-l-2 border-cyan bg-cyan/5 py-2 pr-2' : 'border-l-2 border-transparent'
      } ${flash ? 'bg-electric/15' : ''}`}
    >
      {!bigMode && <SegmentMeta segment={s} />}
      {s.text_vi ? (
        <EditableText value={s.text_vi} canEdit={canEdit} onSave={(v) => onSave(s.id, v)}>
          <p>{highlightNumbers(s.text_vi)}</p>
        </EditableText>
      ) : draft ? (
        <p className="text-fg/80">
          {draft}
          <span className="ml-0.5 inline-block h-[0.9em] w-[2px] animate-pulse bg-electric align-middle" />
        </p>
      ) : s.translation_status === 'error' ? (
        <div className="text-sm text-live">
          Không dịch được: {s.translation_error}
          {canEdit && (
            <button onClick={() => onRetranslate(s.id)} className="ml-2 font-medium text-fg underline-offset-2 hover:underline">
              Dịch lại
            </button>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-faint">
          <Spinner /> Đang dịch…
        </p>
      )}
      <div className="absolute top-0 right-0 flex items-center gap-1">
        {canEdit && s.text_vi && s.translation_status !== 'pending' && (
          <button
            onClick={() => onRetranslate(s.id)}
            className="rounded px-1.5 py-0.5 text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-panel-2 hover:text-fg focus:opacity-100"
          >
            Dịch lại
          </button>
        )}
        <HideLineButton onClick={() => onHide(s.id)} />
      </div>
      {canEdit && (
        <button
          onClick={() => onToggleImportant(s)}
          aria-label={s.is_important ? 'Bỏ đánh dấu quan trọng' : 'Đánh dấu quan trọng'}
          className={`absolute top-1 -left-3 text-sm ${s.is_important ? 'text-cyan' : 'text-faint opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
        >
          ★
        </button>
      )}
    </div>
  );
});
