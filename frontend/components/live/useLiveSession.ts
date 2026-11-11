'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomState } from '@conference-copilot/shared';
import { AudioCapture, type AudioSource } from '@/lib/audio';
import { LiveSocket, type ConnectionState, type LiveEvent } from '@/lib/live';

export type PartialLine = { text: string; language: string | null; speaker: string | null };

/** Errors after which this device must release the microphone. */
const STOP_CAPTURE_ON = ['stt_failed', 'stt_not_configured', 'host_busy', 'forbidden', 'start_failed', 'budget_exceeded'];

interface LiveSessionOptions {
  conferenceId: string;
  userId: string;
  /** Transcript events (segment, translation.*) are handed here. */
  onTranscriptEvent: (e: LiveEvent) => void;
  /** Called each time the socket (re)opens, to fetch what changed while offline. */
  onConnected: () => void;
}

/**
 * The live room as seen from this tab: the WebSocket, the room state, the interim line, and, when this tab is the
 * recording host, the microphone capture. One socket per open conference page.
 */
export function useLiveSession({ conferenceId, userId, onTranscriptEvent, onConnected }: LiveSessionOptions) {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [partial, setPartial] = useState<PartialLine | null>(null);
  const [conn, setConn] = useState<ConnectionState>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [level, setLevel] = useState(0);
  const [queued, setQueued] = useState(0);
  const [now, setNow] = useState(Date.now());

  const socketRef = useRef<LiveSocket | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const sendingRef = useRef(false);
  // Latest callbacks, so the socket is created once per conference and never re-created by a re-render.
  const callbacks = useRef({ onTranscriptEvent, onConnected });
  callbacks.current = { onTranscriptEvent, onConnected };

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
          if (captureRef.current) {
            if (e.youAreHost) sendingRef.current = e.status === 'live';
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
        case 'error':
          setNotice(e.message);
          if (STOP_CAPTURE_ON.includes(e.code)) stopCapture();
          break;
        default:
          callbacks.current.onTranscriptEvent(e);
      }
    },
    [stopCapture],
  );

  useEffect(() => {
    const socket = new LiveSocket(conferenceId, handleEvent, (s, detail) => {
      setConn(s);
      if (s === 'open') {
        setNotice(null);
        callbacks.current.onConnected();
      } else if (detail) setNotice(detail);
    });
    socketRef.current = socket;
    void socket.connect();
    return () => {
      socket.close();
      captureRef.current?.stop();
    };
  }, [conferenceId, handleEvent]);

  // One clock for the elapsed timer and the "audio waiting to be re-sent" badge.
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (socketRef.current) setQueued(socketRef.current.queuedChunks);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Warn before closing the tab that is recording.
  useEffect(() => {
    if (!capturing) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [capturing]);

  const startListening = async (source: AudioSource) => {
    const socket = socketRef.current;
    if (!socket) return;
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
    if (room?.status === 'paused' && room.hostUserId === userId) {
      socket.send({ type: 'reclaim' });
      socket.send({ type: 'resume' });
    } else {
      socket.send({ type: 'start', audioSource: source.kind === 'system' ? 'system' : `device:${source.label}`.slice(0, 120), consent: true });
    }
  };

  const pause = () => socketRef.current?.send({ type: 'pause' });
  const resume = () => socketRef.current?.send({ type: 'resume' });
  const stop = () => {
    socketRef.current?.send({ type: 'stop' });
    stopCapture();
  };

  const status = room?.status ?? 'idle';
  const someoneElseHosting = Boolean(room?.hostConnected && !room.youAreHost);
  const startedMs = room?.startedAt ? now - new Date(room.startedAt).getTime() : 0;

  return {
    room,
    status,
    partial,
    conn,
    notice,
    dismissNotice: () => setNotice(null),
    /** True while this tab is recording (it is the host). */
    capturing,
    level,
    queued,
    startedMs,
    someoneElseHosting,
    startListening,
    pause,
    resume,
    stop,
  };
}
