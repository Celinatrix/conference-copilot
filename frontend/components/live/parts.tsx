'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api, languageLabel, LANGUAGES, type Conference, type Segment } from '@/lib/api';
import { captureSupport, describeMediaError, listInputDevices, requestMicPermission, type AudioSource } from '@/lib/audio';
import { Badge, Button, Dialog, ErrorBanner, Field, inputClass } from '@/components/ui';
import { useRouter } from 'next/navigation';
import type { ResponseMode } from '@conference-copilot/shared';

export const clock = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Visually emphasise numbers, percentages and amounts so key figures stand out while reading fast. */
export function highlightNumbers(text: string): ReactNode[] {
  return text.split(/(\$?\d[\d.,:]*\s?%?)/g).map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts come from splitting one string and never reorder.
      <span key={i} className="num-hl">{part}</span>
    ) : (
      part
    ),
  );
}

/** Keeps a scroll container pinned to the bottom unless the reader scrolled up. */
export function useAutoScroll(ref: RefObject<HTMLDivElement | null>, dep: unknown) {
  const [atBottom, setAtBottom] = useState(true);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      pinned.current = near;
      setAtBottom(near);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `dep` is the trigger: re-pin to the bottom whenever the content changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [ref, dep]);
  const jump = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinned.current = true;
    setAtBottom(true);
  }, [ref]);
  return { atBottom, jump };
}

export function JumpToLatest({ show, onClick }: { show: boolean; onClick: () => void }) {
  if (!show) return null;
  return (
    <button type="button" onClick={onClick} className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-electric/50 bg-panel-2 px-4 py-1.5 text-xs font-medium text-fg shadow-lg hover:bg-electric/20">
      ↓ Nội dung mới
    </button>
  );
}

export function EditableText({
  value,
  onSave,
  canEdit,
  className = '',
  children,
}: {
  value: string;
  onSave: (v: string) => Promise<void>;
  canEdit: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing)
    return (
      <div className={`group relative ${className}`}>
        {children}
        {canEdit && (
          <button type="button"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            className="absolute -top-1 -right-1 rounded p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus:opacity-100"
            aria-label="Sửa nội dung"
            title="Sửa nội dung nhận dạng sai"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2}><path d="M4 20h4L19 9l-4-4L4 16v4z" /></svg>
          </button>
        )}
      </div>
    );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không lưu được');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <textarea className={`${inputClass} min-h-20`} value={draft} onChange={(e) => setDraft(e.target.value)}
        // biome-ignore lint/a11y/noAutofocus: the editor opens because the user just clicked "edit"; focus belongs here.
        autoFocus
      />
      {error && <div className="text-xs text-live">{error}</div>}
      <div className="flex gap-2">
        <Button variant="primary" className="px-2.5 py-1 text-xs" loading={saving} onClick={save} disabled={!draft.trim()}>Lưu</Button>
        <Button variant="subtle" className="px-2.5 py-1 text-xs" onClick={() => setEditing(false)}>Hủy</Button>
      </div>
    </div>
  );
}

export function SegmentMeta({ segment }: { segment: Segment }) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-faint">
      <span>{clock(segment.created_at)}</span>
      {segment.speaker && <span className="text-muted">{segment.speaker}</span>}
      {segment.language && <span className="rounded bg-cyan/10 px-1.5 py-px text-cyan">{segment.language.toUpperCase()}</span>}
      {segment.confidence !== null && segment.confidence < 0.6 && <span className="text-warn" title="Độ tin cậy nhận dạng thấp">?{Math.round(segment.confidence * 100)}%</span>}
      {segment.edited && <span title="Đã chỉnh sửa thủ công">✎</span>}
    </div>
  );
}

export function StartDialog({ open, onClose, onStart }: { open: boolean; onClose: () => void; onStart: (source: AudioSource) => Promise<void> }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [choice, setChoice] = useState<string>('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const support = typeof window !== 'undefined' ? captureSupport() : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh devices each time the dialog opens, not when support info is recomputed.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConsent(false);
    (async () => {
      try {
        await requestMicPermission();
        const list = await listInputDevices();
        setDevices(list);
        setChoice((c) => c || (list[0] ? `device:${list[0].deviceId}` : support?.system ? 'system' : ''));
      } catch (err) {
        setError(describeMediaError(err));
        if (support?.system) setChoice('system');
      }
    })();
  }, [open]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const source: AudioSource =
        choice === 'system'
          ? { kind: 'system', label: 'system-audio' }
          : { kind: 'device', deviceId: choice.slice('device:'.length), label: devices.find((d) => `device:${d.deviceId}` === choice)?.label || 'microphone' };
      await onStart(source);
      onClose();
    } catch (err) {
      setError(describeMediaError(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Bắt đầu nghe">
      <div className="space-y-5">
        {support && !support.secureContext && <ErrorBanner message="Cần mở ứng dụng qua HTTPS hoặc localhost để thu âm." />}
        {error && <ErrorBanner message={error} />}
        <Field label="Nguồn âm thanh">
          <div className="space-y-2">
            {devices.map((d, i) => (
              <SourceOption key={d.deviceId} checked={choice === `device:${d.deviceId}`} onSelect={() => setChoice(`device:${d.deviceId}`)} title={d.label || `Micro ${i + 1}`} subtitle="Micro / USB audio interface / thiết bị ngoài" />
            ))}
            {support?.system && (
              <SourceOption checked={choice === 'system'} onSelect={() => setChoice('system')} title="Âm thanh hệ thống (tab / màn hình)" subtitle="Cho hội nghị online. Chrome/Edge: bật “Chia sẻ âm thanh” khi chọn." />
            )}
          </div>
        </Field>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-warn/25 bg-warn/5 p-3.5 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-electric)]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="text-muted">
            Tôi xác nhận đã được phép ghi âm và chuyển giọng nói thành văn bản tại sự kiện này theo quy định của ban tổ chức. Âm thanh được gửi tới dịch vụ nhận dạng giọng nói để xử lý và <b className="text-fg">không được lưu lại</b>.
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="subtle" onClick={onClose}>Hủy</Button>
          <Button variant="primary" onClick={start} loading={starting} disabled={!consent || !choice}>Start Listening</Button>
        </div>
      </div>
    </Dialog>
  );
}

function SourceOption({ checked, onSelect, title, subtitle }: { checked: boolean; onSelect: () => void; title: string; subtitle: string }) {
  return (
    <button type="button" onClick={onSelect} className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${checked ? 'border-electric bg-electric/10' : 'border-line-strong hover:border-electric/50'}`}>
      <span className={`mt-1 grid size-4 shrink-0 place-items-center rounded-full border ${checked ? 'border-electric' : 'border-line-strong'}`}>
        {checked && <span className="size-2 rounded-full bg-electric" />}
      </span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-faint">{subtitle}</span>
      </span>
    </button>
  );
}

const DEFAULT_MODES: ResponseMode[] = ['professional', 'concise', 'strategic'];
const RESPONSE_MODE_OPTIONS: [ResponseMode, string][] = [
  ['professional', 'Chuyên nghiệp'],
  ['concise', 'Ngắn gọn'],
  ['strategic', 'Chiến lược'],
  ['academic', 'Học thuật'],
  ['technical', 'Chuyên sâu'],
];

export function ConferenceSettingsDialog({ open, onClose, conference, onSaved, locked }: { open: boolean; onClose: () => void; conference: Conference; onSaved: (c: Conference) => void; locked: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState(conference);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modes, setModes] = useState<ResponseMode[]>(conference.response_modes ?? DEFAULT_MODES);
  useEffect(() => {
    if (!open) return;
    setForm(conference);
    setModes(conference.response_modes?.length ? conference.response_modes : DEFAULT_MODES);
  }, [open, conference]);

  // 1 to 3 styles; picking a 4th is refused by the server, so the toggle just does nothing then.
  const toggleMode = (m: ResponseMode) =>
    setModes((cur) => (cur.includes(m) ? (cur.length > 1 ? cur.filter((x) => x !== m) : cur) : cur.length < 3 ? [...cur, m] : cur));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { conference: c } = await api<{ conference: Conference }>(`/api/conferences/${conference.id}`, {
        method: 'PATCH',
        json: {
          name: form.name,
          location: form.location,
          speakers: form.speakers,
          input_language: form.input_language,
          glossary: form.glossary,
          visibility: form.visibility,
          response_modes: modes,
        },
      });
      onSaved(c);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không lưu được');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Xóa vĩnh viễn "${conference.name}" cùng toàn bộ transcript và bản dịch? Thao tác này không thể hoàn tác.`)) return;
    try {
      await api(`/api/conferences/${conference.id}`, { method: 'DELETE' });
      router.replace('/conferences');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không xóa được');
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Thông tin hội nghị" wide>
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <Field label="Tên"><input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Địa điểm"><input className={inputClass} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
          <Field label="Diễn giả"><input className={inputClass} value={form.speakers} onChange={(e) => setForm({ ...form, speakers: e.target.value })} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ngôn ngữ đầu vào" hint={locked ? 'Áp dụng từ phiên nghe tiếp theo.' : undefined}>
            <select className={inputClass} value={form.input_language} onChange={(e) => setForm({ ...form, input_language: e.target.value })}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </Field>
          <Field label="Quyền riêng tư">
            <select className={inputClass} value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as Conference['visibility'] })}>
              <option value="private">Riêng tư – chỉ mình tôi</option>
              <option value="workspace">Chia sẻ với workspace</option>
            </select>
          </Field>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">Kiểu gợi ý trả lời (1–3)</div>
          <div className="flex flex-wrap gap-2">
            {RESPONSE_MODE_OPTIONS.map(([m, label]) => (
              <button
                type="button"
                key={m}
                aria-pressed={modes.includes(m)}
                onClick={() => toggleMode(m)}
                className={`rounded-full border px-3 py-1 text-xs ${modes.includes(m) ? 'border-electric bg-electric/15 text-fg' : 'border-line-strong text-muted hover:text-fg'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Field label="Glossary" hint="Mỗi dòng một thuật ngữ, dạng `thuật ngữ = cách dịch` (hoặc chỉ thuật ngữ để giữ nguyên). Bản dịch lệch glossary sẽ bị gắn cờ. Áp dụng cho các đoạn dịch tiếp theo.">
          <textarea className={`${inputClass} min-h-24`} value={form.glossary} onChange={(e) => setForm({ ...form, glossary: e.target.value })} />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          {conference.permissions?.canDelete ? (
            <Button variant="danger" onClick={remove} disabled={locked} title={locked ? 'Dừng phiên trước khi xóa' : undefined}>Xóa hội nghị</Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="subtle" onClick={onClose}>Hủy</Button>
            <Button variant="primary" loading={saving} onClick={save}>Lưu</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export function LangBadge({ code }: { code: string | null }) {
  return <Badge tone="cyan">{languageLabel(code)}</Badge>;
}
