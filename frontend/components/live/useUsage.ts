'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type Usage } from '@/lib/api';

/** Estimated AI spend for one conference: loaded on demand, and refreshed every 30 s while a session runs. */
export function useUsage(conferenceId: string, sessionRunning: boolean) {
  const [usage, setUsage] = useState<Usage | null>(null);

  const refresh = useCallback(() => {
    api<Usage>(`/api/conferences/${conferenceId}/usage`)
      .then(setUsage)
      .catch(() => {});
  }, [conferenceId]);

  /** The server records the last minute of STT usage while closing a session, so read it a moment later. */
  const refreshSoon = useCallback(() => {
    setTimeout(refresh, 2000);
  }, [refresh]);

  useEffect(() => {
    if (!sessionRunning) return;
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [sessionRunning, refresh]);

  return { usage, refresh, refreshSoon };
}
