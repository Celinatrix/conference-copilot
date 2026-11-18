'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui';

type TtsStatus = { state: string; voice?: string; message?: string };

/**
 * "Locked-screen" listening: plays the server's live MP3 of the Vietnamese translation as ordinary media.
 * iPhone/Android keep media playing with the screen off, unlike in-page speech synthesis.
 */
export function ListenStream({ conferenceId, title, onStart }: { conferenceId: string; title: string; onStart: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wantRef = useRef(false);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<'off' | 'connecting' | 'playing' | 'error'>('off');
  const [message, setMessage] = useState<string | null>(null);

  const src = () => `/api/conferences/${conferenceId}/listen.mp3?t=${Date.now()}`;

  const stop = () => {
    wantRef.current = false;
    if (retryRef.current) clearTimeout(retryRef.current);
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    setState('off');
  };

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => {
    // play() must run synchronously inside the tap, or iOS refuses to start audio.
    let a = audioRef.current;
    if (!a) {
      a = new Audio();
      a.preload = 'none';
      a.addEventListener('playing', () => {
        setState('playing');
        setMessage(null);
      });
      a.addEventListener('error', () => {
        if (!wantRef.current) return;
        setState('error');
        // Ask the server why (no voice installed, not logged in...) and retry: a dropped connection recovers.
        api<{ status: TtsStatus }>('/api/tts/status')
          .then(({ status }) => setMessage(status.state === 'ready' ? 'Mất kết nối luồng âm thanh, đang thử lại…' : status.message ?? 'Bộ đọc giọng nói chưa sẵn sàng.'))
          .catch((err) => setMessage(err instanceof Error ? err.message : 'Không kết nối được máy chủ.'));
        retryRef.current = setTimeout(() => {
          if (!wantRef.current || !audioRef.current) return;
          audioRef.current.src = src();
          void audioRef.current.play().catch(() => {});
        }, 3000);
      });
      a.addEventListener('ended', () => {
        if (wantRef.current && audioRef.current) {
          audioRef.current.src = src();
          void audioRef.current.play().catch(() => {});
        }
      });
      audioRef.current = a;
    }
    wantRef.current = true;
    setState('connecting');
    setMessage(null);
    a.src = src();
    void a.play().catch((err: Error) => {
      if (err.name === 'NotAllowedError') {
        setState('error');
        setMessage('Trình duyệt chặn phát âm thanh. Bấm lại nút một lần nữa.');
      }
    });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'Bản dịch tiếng Việt', artist: title, album: 'Conference Copilot' });
    }
    onStart();
  };

  const test = async () => {
    try {
      await api(`/api/conferences/${conferenceId}/listen/test`, { method: 'POST' });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Không thử được');
    }
  };

  const on = state !== 'off';
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        onClick={on ? stop : start}
        aria-pressed={on}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
          state === 'playing' ? 'border-ok/40 bg-ok/15 text-ok' : on ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line-strong text-muted hover:text-fg'
        }`}
        title="Phát bản dịch như một luồng nhạc: vẫn nghe được khi khóa màn hình"
      >
        {state === 'playing' ? '🎧 Đang phát (tắt màn hình vẫn nghe)' : state === 'connecting' ? '🎧 Đang kết nối…' : state === 'error' ? '🎧 Lỗi, bấm để tắt' : '🎧 Nghe khi tắt màn hình'}
      </button>
      {state === 'playing' && (
        <button onClick={() => void test()} className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] text-muted hover:text-fg">
          Thử tiếng
        </button>
      )}
      {message && (
        // Long setup instructions stay one click away instead of filling the status bar.
        <button onClick={() => window.alert(message)} title={message} className="max-w-full">
          <Badge tone="warn">{/giọng đọc/i.test(message) ? '⚠ Windows chưa có giọng tiếng Việt (bấm để xem cách cài)' : message.length > 80 ? `${message.slice(0, 77)}…` : message}</Badge>
        </button>
      )}
    </span>
  );
}
