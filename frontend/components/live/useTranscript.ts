'use client';

import { useCallback, useRef, useState } from 'react';
import { api, type Segment } from '@/lib/api';
import type { SegmentPage } from '@conference-copilot/shared';
import type { LiveEvent } from '@/lib/live';
type SegmentPatch = Partial<Pick<Segment, 'text_original' | 'text_vi' | 'is_important'>>;

/** Merges a sync delta into the list by id, keeping seq order. */
export function mergeSegments(prev: Segment[], incoming: Segment[]): Segment[] {
  if (!incoming.length) return prev;
  const byId = new Map(prev.map((s) => [s.id, s]));
  for (const s of incoming) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

const replaceById = (segId: string, next: (s: Segment) => Segment) => (prev: Segment[]) => prev.map((s) => (s.id === segId ? next(s) : s));

/**
 * The conference transcript as this page sees it: stored segments, Vietnamese text still streaming in, and the
 * recent translation latencies. Fed by the history load, by live events and by the catch-up after a reconnect.
 */
export function useTranscript(conferenceId: string) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [latencies, setLatencies] = useState<number[]>([]);
  /** Server timestamp of the last transcript sync; a reconnect fetches only what changed after it. */
  const syncCursorRef = useRef<string | null>(null);
  /** Segments up to this seq came from history and render without the entry animation. */
  const historySeqRef = useRef(0);

  /** Full history, page by page, merged with anything that already arrived live. Throws on failure (the page shows it). */
  const loadHistory = useCallback(async () => {
    const all: Segment[] = [];
    let cursor: string | null = null;
    let afterSeq = 0;
    for (;;) {
      const page: SegmentPage = await api<SegmentPage>(`/api/conferences/${conferenceId}/segments?afterSeq=${afterSeq}`);
      // The first page's timestamp is the safe sync cursor: anything changed while later pages load is newer.
      cursor ??= page.serverTime;
      all.push(...page.segments);
      if (page.nextAfterSeq === null) break;
      afterSeq = page.nextAfterSeq;
    }
    syncCursorRef.current = cursor;
    historySeqRef.current = all.at(-1)?.seq ?? 0;
    setSegments((prev) => mergeSegments(all, prev));
  }, [conferenceId]);

  /** Catch up on what was stored or edited while offline: only the delta, not the whole transcript. */
  const catchUp = useCallback(() => {
    const since = syncCursorRef.current;
    if (!since) return;
    api<SegmentPage>(`/api/conferences/${conferenceId}/segments?since=${encodeURIComponent(since)}`)
      .then((r) => {
        syncCursorRef.current = r.serverTime;
        setSegments((prev) => mergeSegments(prev, r.segments));
      })
      .catch(() => {});
  }, [conferenceId]);

  /** Applies the live events that change the transcript; returns false for events it does not handle. */
  const applyEvent = useCallback((e: LiveEvent): boolean => {
    switch (e.type) {
      case 'segment':
        setSegments((prev) => (prev.some((s) => s.id === e.segment.id) ? prev : [...prev, e.segment].sort((a, b) => a.seq - b.seq)));
        return true;
      case 'segment.updated':
        setSegments(replaceById(e.segment.id, () => e.segment));
        return true;
      case 'translation.delta':
        setDrafts((d) => ({ ...d, [e.segmentId]: (d[e.segmentId] ?? '') + e.delta }));
        return true;
      case 'translation.done':
        setSegments(replaceById(e.segmentId, (s) => ({ ...s, text_vi: e.text_vi, translation_status: 'done', translation_error: null, flags: e.flags })));
        setDrafts(({ [e.segmentId]: _, ...rest }) => rest);
        if (e.latencyMs !== null) setLatencies((l) => [...l.slice(-19), e.latencyMs as number]);
        return true;
      case 'translation.error':
        setSegments(replaceById(e.segmentId, (s) => ({ ...s, translation_status: 'error', translation_error: e.message })));
        setDrafts(({ [e.segmentId]: _, ...rest }) => rest);
        return true;
      default:
        return false;
    }
  }, []);

  const patchSegment = useCallback(async (segId: string, body: SegmentPatch) => {
    const { segment } = await api<{ segment: Segment }>(`/api/segments/${segId}`, { method: 'PATCH', json: body });
    setSegments(replaceById(segId, () => segment));
  }, []);

  const retranslate = useCallback(async (segId: string) => {
    setSegments(replaceById(segId, (s) => ({ ...s, translation_status: 'pending', translation_error: null })));
    try {
      const { segment } = await api<{ segment: Segment }>(`/api/segments/${segId}/retranslate`, { method: 'POST' });
      setSegments(replaceById(segId, () => segment));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi';
      setSegments(replaceById(segId, (s) => ({ ...s, translation_status: 'error', translation_error: message })));
    }
  }, []);

  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  return { segments, drafts, avgLatency, historySeqRef, loadHistory, catchUp, applyEvent, patchSegment, retranslate };
}
