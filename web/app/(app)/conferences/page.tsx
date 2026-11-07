'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, languageLabel, type Conference } from '@/lib/api';
import { NewConferenceDialog } from '@/components/NewConferenceDialog';
import { Badge, Button, Card, ErrorBanner, Spinner, StatusPill, inputClass } from '@/components/ui';

export default function ConferencesPage() {
  const [items, setItems] = useState<Conference[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = (query: string) => {
    setError(null);
    api<{ conferences: Conference[] }>(`/api/conferences${query ? `?q=${encodeURIComponent(query)}` : ''}`)
      .then((r) => setItems(r.conferences))
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    const t = setTimeout(() => load(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Hội nghị & Lịch sử</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>Hội nghị mới</Button>
      </div>
      <input className={inputClass} placeholder="Tìm theo tên hoặc địa điểm…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm hội nghị" />
      {error && <ErrorBanner message={error} onRetry={() => load(q)} />}
      {!items ? (
        !error && <div className="flex justify-center py-16 text-muted"><Spinner className="size-5" /></div>
      ) : items.length === 0 ? (
        <Card className="p-10 text-center text-muted">{q ? 'Không tìm thấy hội nghị phù hợp.' : 'Chưa có hội nghị nào.'}</Card>
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {items.map((c) => (
            <Link key={c.id} href={`/conferences/${c.id}`} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors hover:bg-panel-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{c.name}</div>
                <div className="text-sm text-muted">
                  {(c.starts_at ? new Date(c.starts_at) : new Date(c.created_at)).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' })}
                  {c.location && ` · ${c.location}`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="cyan">{languageLabel(c.input_language)}</Badge>
                <Badge>{c.segment_count ?? 0} đoạn</Badge>
                <StatusPill status={c.status} />
              </div>
            </Link>
          ))}
        </Card>
      )}
      <NewConferenceDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
