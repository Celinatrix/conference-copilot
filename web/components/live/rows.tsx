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

export const OriginalRow = memo(function OriginalRow({
  segment,
  canEdit,
  animate,
  onSave,
}: {
  segment: Segment;
  canEdit: boolean;
  animate: boolean;
  onSave: (id: string, text: string) => Promise<void>;
}) {
  return (
    <div className={`seg-row ${animate ? 'seg-enter' : ''}`}>
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
}) {
  return (
    <div
      id={`vi-${s.id}`}
      className={`seg-row group relative rounded-xl pl-4 transition-colors ${animate ? 'seg-enter' : ''} ${
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
      {canEdit && s.text_vi && s.translation_status !== 'pending' && (
        <div className="absolute top-0 right-6 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button onClick={() => onRetranslate(s.id)} className="rounded px-1.5 py-0.5 text-[11px] text-faint hover:bg-panel-2 hover:text-fg">
            Dịch lại
          </button>
        </div>
      )}
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
