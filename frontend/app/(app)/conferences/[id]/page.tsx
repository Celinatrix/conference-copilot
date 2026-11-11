'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, type Conference, type Segment, type SystemStatus } from '@/lib/api';
import type { LiveEvent } from '@/lib/live';
import { useSession } from '@/components/AppShell';
import { ErrorBanner, Spinner } from '@/components/ui';
import { ConferenceSettingsDialog, StartDialog } from '@/components/live/parts';
import { LiveHeader } from '@/components/live/LiveHeader';
import { OriginalColumn, ToolsColumn, TranslationColumn } from '@/components/live/columns';
import { useTranscript } from '@/components/live/useTranscript';
import { useLiveSession } from '@/components/live/useLiveSession';
import { useUsage } from '@/components/live/useUsage';
import { useQuestions } from '@/components/live/useQuestions';
import { useFullscreen, useWakeLock } from '@/lib/screen';
import { usePersistentNumber } from '@/lib/usePersistentNumber';

type Tab = 'original' | 'vi' | 'tools';

/**
 * Live conference page. State lives in three hooks (transcript, live session, usage); this component only wires
 * them to the header and the three columns and keeps view state (tab, font size, dialogs, toast).
 */
export default function LiveConferencePage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();

  const [conference, setConference] = useState<Conference | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fontSize, setFontSize] = usePersistentNumber('cc.fontSize', 20);
  const [bigMode, setBigMode] = useState(false);
  const [tab, setTab] = useState<Tab>('vi');
  const [flashId, setFlashId] = useState<string | null>(null);
  const [answersConfigured, setAnswersConfigured] = useState(false);

  const transcript = useTranscript(id);
  const { applyEvent, catchUp, loadHistory, patchSegment, retranslate } = transcript;
  const questions = useQuestions(id);
  const { applyEvent: applyQuestionEvent, ask, load: loadQuestions } = questions;
  // Every non-room event goes to whichever store handles it: transcript first, then questions.
  const onLiveEvent = useCallback((e: LiveEvent) => void (applyEvent(e) || applyQuestionEvent(e)), [applyEvent, applyQuestionEvent]);
  const onConnected = useCallback(() => {
    catchUp();
    // Questions are few; reloading them after a reconnect is simpler than a delta sync.
    loadQuestions().catch(() => {});
  }, [catchUp, loadQuestions]);
  const live = useLiveSession({ conferenceId: id, userId: user.id, onTranscriptEvent: onLiveEvent, onConnected });
  const usage = useUsage(id, live.status === 'live' || live.status === 'paused');
  const refreshUsage = usage.refresh;

  const canManage = Boolean(conference?.permissions?.canManage);
  // Keep the screen awake for the recording device and for anyone reading a live session on a phone.
  const wakeLock = useWakeLock(live.capturing || live.status === 'live');
  const fullscreen = useFullscreen();

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2500);
  }, []);

  const loadAll = useCallback(async () => {
    setLoadError(null);
    try {
      const [{ conference: c }] = await Promise.all([api<{ conference: Conference }>(`/api/conferences/${id}`), loadHistory()]);
      setConference(c);
      refreshUsage();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Không tải được hội nghị');
    }
  }, [id, loadHistory, refreshUsage]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    api<SystemStatus>('/api/system/status')
      .then((s) => setAnswersConfigured(s.answers.configured))
      .catch(() => {});
  }, []);

  const stop = () => {
    if (!window.confirm('Kết thúc phiên nghe? Transcript đã được lưu; bạn có thể bắt đầu phiên mới sau.')) return;
    live.stop();
    usage.refreshSoon();
  };

  const copyTranslation = async () => {
    const text = transcript.segments.map((s) => s.text_vi).filter(Boolean).join('\n');
    if (!text) return showToast('Chưa có bản dịch để sao chép');
    try {
      await navigator.clipboard.writeText(text);
      showToast('Đã sao chép toàn bộ bản dịch');
    } catch {
      showToast('Trình duyệt chặn quyền sao chép');
    }
  };

  // Stable callbacks so memoised rows only re-render when their own segment changes.
  const toggleImportant = useCallback(
    (s: Segment) => patchSegment(s.id, { is_important: !s.is_important }).catch((err) => showToast(err instanceof Error ? err.message : 'Không lưu được')),
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
  const askAboutSegment = useCallback(
    (segmentId: string) => {
      setTab('tools');
      ask({ segmentId }).catch((err) => showToast(err instanceof Error ? err.message : 'Không gửi được yêu cầu'));
    },
    [ask, showToast],
  );

  const focusSegment = (segId: string) => {
    setTab('vi');
    setBigMode(false);
    setFlashId(segId);
    requestAnimationFrame(() => document.getElementById(`vi-${segId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    setTimeout(() => setFlashId(null), 2000);
  };

  if (loadError) {
    return (
      <div className="mx-auto max-w-xl p-8">
        <ErrorBanner message={loadError} onRetry={loadAll} />
        <Link href="/conferences" className="mt-4 inline-block text-sm text-muted">← Danh sách hội nghị</Link>
      </div>
    );
  }
  if (!conference) return <div className="grid h-[60dvh] place-items-center text-muted"><Spinner className="size-5" /></div>;

  const { segments } = transcript;
  const historySeq = transcript.historySeqRef.current;

  return (
    <div className="flex h-dvh flex-col">
      <LiveHeader
        conference={conference}
        userId={user.id}
        canManage={canManage}
        room={live.room}
        status={live.status}
        conn={live.conn}
        notice={live.notice}
        onDismissNotice={live.dismissNotice}
        capturing={live.capturing}
        level={live.level}
        queued={live.queued}
        startedMs={live.startedMs}
        someoneElseHosting={live.someoneElseHosting}
        hasSegments={segments.length > 0}
        onStart={() => setStartOpen(true)}
        onPause={live.pause}
        onResume={live.resume}
        onStop={stop}
        onCopy={copyTranslation}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Mobile tabs */}
      <div className="flex border-b border-line lg:hidden" role="tablist">
        {([['original', 'Bản gốc'], ['vi', 'Tiếng Việt'], ['tools', 'Công cụ']] as const).map(([k, label]) => (
          <button type="button" key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`flex-1 py-2.5 text-sm ${tab === k ? 'border-b-2 border-electric text-fg' : 'text-muted'}`}>{label}</button>
        ))}
      </div>

      <div className={`grid min-h-0 flex-1 ${bigMode ? 'grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(280px,0.8fr)]'}`}>
        {!bigMode && (
          <OriginalColumn hidden={tab !== 'original'} segments={segments} partial={live.partial} canEdit={canManage} historySeq={historySeq} onSave={saveOriginal} />
        )}
        <TranslationColumn
          hidden={!bigMode && tab !== 'vi'}
          segments={segments}
          drafts={transcript.drafts}
          partial={live.partial}
          fontSize={bigMode ? Math.max(fontSize, 30) : fontSize}
          setFontSize={setFontSize}
          bigMode={bigMode}
          setBigMode={setBigMode}
          canEdit={canManage}
          flashId={flashId}
          historySeq={historySeq}
          onSave={saveTranslation}
          onRetranslate={retranslate}
          onToggleImportant={toggleImportant}
          onAsk={answersConfigured ? askAboutSegment : undefined}
          live={live.status === 'live'}
          fullscreen={fullscreen}
          wakeLockHeld={wakeLock.held}
        />
        {!bigMode && (
          <ToolsColumn
            hidden={tab !== 'tools'}
            conferenceId={id}
            segments={segments}
            avgLatency={transcript.avgLatency}
            usage={usage.usage}
            onFocus={focusSegment}
            questions={questions}
            answersConfigured={answersConfigured}
            canManage={canManage}
          />
        )}
      </div>

      <StartDialog open={startOpen} onClose={() => setStartOpen(false)} onStart={live.startListening} />
      <ConferenceSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        conference={conference}
        onSaved={setConference}
        locked={live.status === 'live' || live.status === 'paused'}
      />
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
