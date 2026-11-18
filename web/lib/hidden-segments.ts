'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Transcript lines the listener has cleared from view on this device (the "X" buttons). View-only: the transcript
 * itself, export and search are untouched, and everything can be shown again. Remembered per conference in
 * localStorage so a reload keeps the screen tidy; storage failures just fall back to in-memory state.
 */
export function useHiddenSegments(conferenceId: string) {
  const key = `cc.hidden.${conferenceId}`;
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setHidden(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setHidden(new Set());
    }
  }, [key]);

  const save = useCallback(
    (next: Set<string>) => {
      setHidden(next);
      try {
        if (next.size) localStorage.setItem(key, JSON.stringify([...next]));
        else localStorage.removeItem(key);
      } catch {
        /* private mode or full storage: keep the in-memory state */
      }
    },
    [key],
  );

  const hideOne = useCallback((id: string) => setHidden((prev) => {
    const next = new Set(prev).add(id);
    try {
      localStorage.setItem(key, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
    return next;
  }), [key]);

  const hideAll = useCallback((ids: string[]) => save(new Set([...hidden, ...ids])), [hidden, save]);
  const showOne = useCallback((id: string) => {
    if (!hidden.has(id)) return;
    const next = new Set(hidden);
    next.delete(id);
    save(next);
  }, [hidden, save]);
  const showAll = useCallback(() => save(new Set()), [save]);

  return { hidden, hideOne, hideAll, showOne, showAll };
}
