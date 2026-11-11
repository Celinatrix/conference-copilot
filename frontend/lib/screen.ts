'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Keeps the screen on while `active`. Phones otherwise dim and lock mid-session, and a locked phone stops the
 * page's microphone. The lock is dropped by the browser whenever the tab is hidden, so it is re-requested on return.
 */
export function useWakeLock(active: boolean) {
  const [supported] = useState(() => typeof navigator !== 'undefined' && 'wakeLock' in navigator);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!active || !supported) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (document.visibilityState !== 'visible' || sentinel) return;
      try {
        const s = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void s.release();
          return;
        }
        sentinel = s;
        setHeld(true);
        s.addEventListener('release', () => {
          sentinel = null;
          setHeld(false);
        });
      } catch {
        // Denied (battery saver, permissions policy): the session still works, the screen may just sleep.
        setHeld(false);
      }
    };
    const onVisibility = () => void acquire();

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release();
      setHeld(false);
    };
  }, [active, supported]);

  return { supported, held };
}

export function useFullscreen() {
  const [supported] = useState(() => typeof document !== 'undefined' && Boolean(document.documentElement.requestFullscreen));
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      /* the browser refused (e.g. iOS Safari for non-video elements) */
    }
  }, []);

  return { supported, isFullscreen, toggle };
}
