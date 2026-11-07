'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, type Conference, type Segment, type Usage } from '@/lib/api';
import { AudioCapture, type AudioSource } from '@/lib/audio';
import { LiveSocket, type ConnectionState, type LiveEvent } from '@/lib/live';
import { useSession } from '@/components/AppShell';
import { Badge, Button, Card, ErrorBanner, Spinner, StatusPill, inputClass } from '@/components/ui';
import { ConferenceSettingsDialog, JumpToLatest, LangBadge, StartDialog, elapsed, useAutoScroll } from '@/components/live/parts';
import { OriginalRow, TranslationRow } from '@/components/live/rows';
import { useFullscreen, useWakeLock } from '@/lib/screen';

type RoomState = Extract<LiveEvent, { type: 'state' }>;
type PartialLine = { text: string; language: string | null; speaker: string | null };
type Tab = 'original' | 'vi' | 'tools';
type SegmentsResponse = { segments: Segment[]; serverTime: string };

/** Merges a sync delta into the list by id, keeping seq order. */
function mergeSegments(prev: Segment[], incoming: Segment[]): Segment[] {
  if (!incoming.length) return prev;
  const byId = new Map(prev.map((s) => [s.id, s]));
  for (const s of incoming) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function usePersistentNumber(key: string, initial: number) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (v) setValue(v);
    } catch {}
  }, [key]);
  const update = (v: number) => {
    setValue(v);
    try {
      localStorage.setItem(key, String(v));
    } catch {}
  };
  return [value, update] as const;
}

export default function LiveConferencePage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();

  const [conference, setConference] = useState<Conference | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [partial, setPartial] = useState<PartialLine | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [conn, setConn] = useState<ConnectionState>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [level, setLevel] = useState(0);
  const [queued, setQueued] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [startOpen, setStartOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [fontSize, setFontSize] = usePersistentNumber('cc.fontSize', 20);
  const [bigMode, setBigMode] = useState(false);
  const [tab, setTab] = useState<Tab>('vi');
  const [flashId, setFlashId] = useState<string | null>(null);

  const socketRef = useRef<LiveSocket | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const sendingRef = useRef(false);
  /** Server timestamp of the last transcript sync; a reconnect fetches only what changed after it. */
  const syncCursorRef = useRef<string | null>(null);
  /** Segments up to this seq came from history and render without the entry animation. */
  const historySeqRef = useRef(0);

  const canManage = Boolean(conference?.permissions?.canManage);
  const status = room?.status ?? 'idle';
  const isHost = capturing;
  // Keep the screen awake for the recording device and for anyone reading a live session on a phone.
  const wakeLock = useWakeLock(capturing || status === 'live');
  const fullscreen = useFullscreen();

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2500);
  }, []);

  const stopCapture = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    sendingRef.current = false;
    if (socketRef.current) socketRef.current.wantsHost = false;
    setCapturing(false);
    setLevel(0);
  }, []);

  const handleEvent = useCallback(
    (e: LiveEvent) => {
      switch (e.type) {
        case 'state': {
          setRoom(e);
          const live = e.status === 'live';
          if (captureRef.current) {
            if (e.youAreHost) sendingRef.current = live;
            else if (e.hostConnected || e.status === 'idle') {
              // Another device took over or the session ended (stop, STT failure): release the microphone.
              stopCapture();
            }
          }
          if (e.status === 'idle') setPartial(null);
          break;
        }
        case 'partial':
          setPartial({ text: e.text, language: e.language, speaker: e.speaker });
          break;
        case 'partial.clear':
          setPartial(null);
          break;
        case 'segment':
          setSegments((prev) => (prev.some((s) => s.id === e.segment.id) ? prev : [...prev, e.segment].sort((a, b) => a.seq - b.seq)));
          break;
        case 'segment.updated':
          setSegments((prev) => prev.map((s) => (s.id === e.segment.id ? e.segment : s)));
          break;
        case 'translation.delta':
          setDrafts((d) => ({ ...d, [e.segmentId]: (d[e.segmentId] ?? '') + e.delta }));
          break;
        case 'translation.done':
          setSegments((prev) => prev.map((s) => (s.id === e.segmentId ? { ...s, text_vi: e.text_vi, translation_status: 'done', translation_error: null } : s)));
          setDrafts(({ [e.segmentId]: _, ...rest }) => rest);
          if (e.latencyMs !== null) setLatencies((l) => [...l.slice(-19), e.latencyMs!]);
          break;
        case 'translation.error':
          setSegments((prev) => prev.map((s) => (s.id === e.segmentId ? { ...s, translation_status: 'error', translation_error: e.message } : s)));
          setDrafts(({ [e.segmentId]: _, ...rest }) => rest);
          break;
        case 'error':
          setNotice(e.message);
          if (['stt_failed', 'stt_not_configured', 'host_busy', 'forbidden', 'start_failed', 'budget_exceeded'].includes(e.code)) stopCapture();
          break;
      }
    },
    [stopCapture],
  );

  const loadAll = useCallback(async () => {
    setLoadError(null);
    try {
      const [{ conference: c }, { segments: segs, serverTime }] = await Promise.all([
        api<{ conference: Conference }>(`/api/conferences/${id}`),
        api<SegmentsResponse>(`/api/conferences/${id}/segments`),
      ]);
      setConference(c);
      syncCursorRef.current = serverTime;
      historySeqRef.current = segs.at(-1)?.seq ?? 0;
      setSegments((prev) => mergeSegments(segs, prev));
      api<Usage>(`/api/conferences/${id}/usage`).then(setUsage).catch(() => {});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Không tải được hội nghị');
    }
  }, [id]);

  useEffect(() => {
    void loadAll();
    const socket = new LiveSocket(id, handleEvent, (s, detail) => {
      setConn(s);
      if (s === 'open') {
        setNotice(null);
        // Catch up on what was stored or edited while offline: only the delta, not the whole transcript.
        const since = syncCursorRef.current;
        if (since) {
          api<SegmentsResponse>(`/api/conferences/${id}/segments?since=${encodeURIComponent(since)}`)
            .then((r) => {
              syncCursorRef.current = r.serverTime;
              setSegments((prev) => mergeSegments(prev, r.segments));
            })
            .catch(() => {});
        }
      } else if (detail) setNotice(detail);
    });
    socketRef.current = socket;
    void socket.connect();
    return () => {
      socket.close();
      captureRef.current?.stop();
    };
  }, [id, handleEvent, loadAll]);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (socketRef.current) setQueued(socketRef.current.queuedChunks);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (status !== 'live' && status !== 'paused') return;
    const t = setInterval(() => api<Usage>(`/api/conferences/${id}/usage`).then(setUsage).catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [status, id]);

  useEffect(() => {
    if (!capturing) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [capturing]);

  const startListening = async (source: AudioSource) => {
    const socket = socketRef.current!;
    const capture = new AudioCapture();
    capture.onLevel = setLevel;
    capture.onChunk = (buf) => {
      if (sendingRef.current) socket.sendAudio(buf);
    };
    capture.onEnded = (reason) => {
      setNotice(`${reason} Phiên đã tạm dừng: chọn lại nguồn âm thanh để tiếp tục.`);
      socket.send({ type: 'pause' });
      stopCapture();
    };
    await capture.start(source);
    captureRef.current = capture;
    socket.wantsHost = true;
    setCapturing(true);
    setNotice(null);
    if (status === 'paused' && room?.hostUserId === user.id) {
      socket.send({ type: 'reclaim' });
      socket.send({ type: 'resume' });
    } else {
      socket.send({ type: 'start', audioSource: source.kind === 'system' ? 'system' : `device:${source.label}`.slice(0, 120), consent: true });
    }
  };

  const pause = () => socketRef.current?.send({ type: 'pause' });
  const resume = () => socketRef.current?.send({ type: 'resume' });
  const stop = () => {
    if (!window.confirm('Kết thúc phiên nghe? Transcript đã được lưu; bạn có thể bắt đầu phiên mới sau.')) return;
    socketRef.current?.send({ type: 'stop' });
    stopCapture();
    setTimeout(() => api<Usage>(`/api/conferences/${id}/usage`).then(setUsage).catch(() => {}), 2000);
  };

  const copyTranslation = async () => {
    const text = segments.map((s) => s.text_vi).filter(Boolean).join('\n');
    if (!text) return showToast('Chưa có bản dịch để sao chép');
    try {
      await navigator.clipboard.writeText(text);
      showToast('Đã sao chép toàn bộ bản dịch');
    } catch {
      showToast('Trình duyệt chặn quyền sao chép');
    }
  };

  // Stable callbacks so memoised rows only re-render when their own segment changes.
  const patchSegment = useCallback(async (segId: string, body: Partial<Pick<Segment, 'text_original' | 'text_vi' | 'is_important'>>) => {
    const { segment } = await api<{ segment: Segment }>(`/api/segments/${segId}`, { method: 'PATCH', json: body });
    setSegments((prev) => prev.map((s) => (s.id === segId ? segment : s)));
  }, []);

  const retranslate = useCallback(async (segId: string) => {
    setSegments((prev) => prev.map((s) => (s.id === segId ? { ...s, translation_status: 'pending', translation_error: null } : s)));
    try {
      const { segment } = await api<{ segment: Segment }>(`/api/segments/${segId}/retranslate`, { method: 'POST' });
      setSegments((prev) => prev.map((s) => (s.id === segId ? segment : s)));
    } catch (err) {
      setSegments((prev) => prev.map((s) => (s.id === segId ? { ...s, translation_status: 'error', translation_error: err instanceof Error ? err.message : 'Lỗi' } : s)));
    }
  }, []);

  const toggleImportant = useCallback(
    (s: Segment) =>
      patchSegment(s.id, { is_important: !s.is_important }).catch((err) => showToast(err instanceof Error ? err.message : 'Không lưu được')),
    [patchSegment, showToast],
  );

  const saveOriginal = useCallback(
    async (segId: string, text: string) => {
      await patchSegment(segId, { text_original: text });
      showToast('Đã lưu. Bấm “Dịch lại” ở cột tiếng Việt nếu cần.');
    },
    [patchSegment, showToast],
  );

  const saveTranslation = useCallback((segId: string, text: string) => patchSegment(segId, { text_vi: text }), [patchSegment]);

  const focusSegment = (segId: string) => {
    setTab('vi');
    setBigMode(false);
    setFlashId(segId);
    requestAnimationFrame(() => document.getElementById(`vi-${segId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    setTimeout(() => setFlashId(null), 2000);
  };

  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  if (loadError) return <div className="mx-auto max-w-xl p-8"><ErrorBanner message={loadError} onRetry={loadAll} /><Link href="/conferences" className="mt-4 inline-block text-sm text-muted">← Danh sách hội nghị</Link></div>;
  if (!conference) return <div className="grid h-[60dvh] place-items-center text-muted"><Spinner className="size-5" /></div>;

  const someoneElseHosting = room?.hostConnected && !room.youAreHost;
  const startedMs = room?.startedAt ? now - new Date(room.startedAt).getTime() : 0;

  return (
    <div className="flex h-dvh flex-col">
      {/* Header */}
      <header className="border-b border-line bg-navy/60 px-4 py-3 backdrop-blur sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs text-faint">
              <Link href="/conferences" className="hover:text-fg">Hội nghị</Link>
              <span>/</span>
              <button onClick={() => setSettingsOpen(true)} className="hover:text-fg">{conference.location || 'Thông tin'}</button>
            </div>
            <div className="flex items-center gap-3">
              <h1 className="truncate text-lg font-semibold">{conference.name}</h1>
              <StatusPill status={status === 'idle' ? conference.status === 'draft' && segments.length === 0 ? 'draft' : 'ended' : status === 'ending' ? 'ended' : status} />
              {(status === 'live' || status === 'paused') && <span className="font-mono text-sm text-muted tabular-nums">{elapsed(startedMs)}</span>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {capturing && (
              <div className="flex h-8 w-16 items-end gap-0.5" aria-label="Mức âm thanh" title="Mức âm thanh đầu vào">
                {[0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((th, i) => (
                  <span key={i} className={`flex-1 rounded-sm transition-colors ${Math.sqrt(level) * 1.6 > th ? 'bg-cyan' : 'bg-line-strong'}`} style={{ height: `${30 + i * 14}%` }} />
                ))}
              </div>
            )}
            {canManage && !capturing && status !== 'ending' && (
              <Button variant="primary" onClick={() => setStartOpen(true)} disabled={Boolean(someoneElseHosting) || conn !== 'open'} title={someoneElseHosting ? 'Một thiết bị khác đang thu âm' : undefined}>
                <span className="size-2 rounded-full bg-white" />
                {status === 'paused' && room?.hostUserId === user.id ? 'Tiếp tục trên thiết bị này' : 'Start Listening'}
              </Button>
            )}
            {isHost && status === 'live' && <Button onClick={pause}>Pause</Button>}
            {isHost && status === 'paused' && <Button variant="primary" onClick={resume}>Resume</Button>}
            {canManage && (status === 'live' || status === 'paused') && <Button variant="danger" onClick={stop}>Stop Session</Button>}
            <div className="relative">
              <Button onClick={() => setExportOpen((o) => !o)} disabled={segments.length === 0}>Export</Button>
              {exportOpen && (
                <div className="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-line-strong bg-panel p-1.5 shadow-xl" onMouseLeave={() => setExportOpen(false)}>
                  {[
                    ['md', 'both', 'Markdown – gốc + tiếng Việt'],
                    ['md', 'vi', 'Markdown – chỉ tiếng Việt'],
                    ['txt', 'both', 'Văn bản – gốc + tiếng Việt'],
                    ['txt', 'original', 'Văn bản – chỉ bản gốc'],
                  ].map(([format, view, label]) => (
                    <a key={label} href={`/api/conferences/${id}/export?format=${format}&view=${view}`} onClick={() => setExportOpen(false)} className="block rounded-lg px-3 py-2 text-sm text-muted hover:bg-panel-2 hover:text-fg">
                      {label}
                    </a>
                  ))}
                </div>
              )}
            </div>
            <Button onClick={copyTranslation} disabled={segments.length === 0}>Copy Translation</Button>
            {canManage && (
              <Button variant="subtle" onClick={() => setSettingsOpen(true)} aria-label="Thông tin hội nghị">
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>
              </Button>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <ConnBadge conn={conn} />
          {room && room.sttStatus !== 'idle' && <Badge tone={room.sttStatus === 'open' ? 'ok' : 'warn'}>STT: {sttLabel(room.sttStatus)}</Badge>}
          {someoneElseHosting && <Badge tone="cyan">Đang xem bản dịch trực tiếp từ thiết bị khác</Badge>}
          {status === 'paused' && !room?.hostConnected && <Badge tone="warn">Thiết bị thu âm mất kết nối</Badge>}
          {queued > 5 && <Badge tone="warn">Đang giữ {(queued / 10).toFixed(0)}s âm thanh chờ gửi lại</Badge>}
          {room && <span className="text-faint">{room.viewers} người đang xem</span>}
        </div>
        {notice && <div className="mt-3"><ErrorBanner message={notice} onRetry={() => setNotice(null)} /></div>}
      </header>

      {/* Mobile tabs */}
      <div className="flex border-b border-line lg:hidden" role="tablist">
        {([['original', 'Bản gốc'], ['vi', 'Tiếng Việt'], ['tools', 'Công cụ']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`flex-1 py-2.5 text-sm ${tab === k ? 'border-b-2 border-electric text-fg' : 'text-muted'}`}>{label}</button>
        ))}
      </div>

      <div className={`grid min-h-0 flex-1 ${bigMode ? 'grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(280px,0.8fr)]'}`}>
        {!bigMode && (
          <OriginalColumn
            hidden={tab !== 'original'}
            segments={segments}
            partial={partial}
            canEdit={canManage}
            historySeq={historySeqRef.current}
            onSave={saveOriginal}
          />
        )}
        <TranslationColumn
          hidden={!bigMode && tab !== 'vi'}
          segments={segments}
          drafts={drafts}
          partial={partial}
          fontSize={bigMode ? Math.max(fontSize, 30) : fontSize}
          setFontSize={setFontSize}
          bigMode={bigMode}
          setBigMode={setBigMode}
          canEdit={canManage}
          flashId={flashId}
          historySeq={historySeqRef.current}
          onSave={saveTranslation}
          onRetranslate={retranslate}
          onToggleImportant={toggleImportant}
          live={status === 'live'}
          fullscreen={fullscreen}
          wakeLockHeld={wakeLock.held}
        />
        {!bigMode && (
          <ToolsColumn
            hidden={tab !== 'tools'}
            conferenceId={id}
            segments={segments}
            avgLatency={avgLatency}
            usage={usage}
            onFocus={focusSegment}
          />
        )}
      </div>

      <StartDialog open={startOpen} onClose={() => setStartOpen(false)} onStart={startListening} />
      <ConferenceSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} conference={conference} onSaved={setConference} locked={status === 'live' || status === 'paused'} />
      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-line-strong bg-panel-2 px-4 py-2 text-sm shadow-xl">
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function sttLabel(s: string) {
  return ({ connecting: 'đang kết nối', open: 'đang nghe', reconnecting: 'đang kết nối lại', closed: 'đã đóng', failed: 'lỗi' } as Record<string, string>)[s] ?? s;
}

function ConnBadge({ conn }: { conn: ConnectionState }) {
  if (conn === 'open') return <Badge tone="ok"><span className="size-1.5 rounded-full bg-ok" />Đã kết nối</Badge>;
  if (conn === 'closed') return <Badge>Ngắt kết nối</Badge>;
  return <Badge tone="warn"><Spinner className="size-2.5" />{conn === 'connecting' ? 'Đang kết nối' : 'Mất mạng – đang thử lại'}</Badge>;
}

function ColumnHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
      <h2 className="text-xs font-medium tracking-[0.18em] text-faint uppercase">{title}</h2>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function OriginalColumn({ hidden, segments, partial, canEdit, historySeq, onSave }: { hidden: boolean; segments: Segment[]; partial: PartialLine | null; canEdit: boolean; historySeq: number; onSave: (id: string, text: string) => Promise<void> }) {
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

function TranslationColumn(props: {
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
        <button onClick={() => setFontSize(Math.max(14, fontSize - 2))} className="rounded-md px-2 py-1 text-sm text-muted hover:bg-panel-2 hover:text-fg" aria-label="Giảm cỡ chữ">A−</button>
        <span className="w-8 text-center font-mono text-[11px] text-faint">{fontSize}</span>
        <button onClick={() => setFontSize(Math.min(48, fontSize + 2))} className="rounded-md px-2 py-1 text-base text-muted hover:bg-panel-2 hover:text-fg" aria-label="Tăng cỡ chữ">A+</button>
        <button onClick={() => setBigMode(!bigMode)} className={`ml-1 rounded-md border px-2.5 py-1 text-xs ${bigMode ? 'border-electric bg-electric/15 text-fg' : 'border-line-strong text-muted hover:text-fg'}`}>
          {bigMode ? 'Thoát chữ lớn' : 'Chế độ chữ lớn'}
        </button>
        {fullscreen.supported && (
          <button
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

function ToolsColumn({ hidden, conferenceId, segments, avgLatency, usage, onFocus }: { hidden: boolean; conferenceId: string; segments: Segment[]; avgLatency: number | null; usage: Usage | null; onFocus: (id: string) => void }) {
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
                  <button onClick={() => onFocus(s.id)} className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-muted hover:bg-panel-2 hover:text-fg">
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
                  <button onClick={() => onFocus(s.id)} className="w-full rounded-lg border-l-2 border-cyan px-3 py-1.5 text-left text-sm text-muted hover:bg-panel-2 hover:text-fg">
                    <span className="line-clamp-3">{s.text_vi || s.text_original}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Card className="border-dashed p-4">
          <div className="text-sm font-medium">AI Response Assistant</div>
          <p className="mt-1 text-xs leading-relaxed text-faint">
            Gợi ý câu trả lời dựa trên tài liệu (RAG) và phát hiện câu hỏi sẽ có ở vòng phát triển tiếp theo, sau khi có Knowledge Base. Hiện chưa có gì ở đây để tránh hiển thị chức năng chưa hoạt động.
          </p>
        </Card>
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
