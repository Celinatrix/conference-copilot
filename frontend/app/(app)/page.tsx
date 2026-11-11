'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { api, languageLabel, type Conference, type SystemStatus } from '@/lib/api';
import { useSession } from '@/components/AppShell';
import { NewConferenceDialog } from '@/components/NewConferenceDialog';
import { Badge, Button, Card, ErrorBanner, Spinner, StatusPill } from '@/components/ui';

interface Dashboard {
  recent: Conference[];
  active: Conference[];
  stats: { conferences: number; segments: number; minutes: number; cost: number };
}

export default function DashboardPage() {
  const { user } = useSession();
  const [data, setData] = useState<Dashboard | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    setError(null);
    Promise.all([api<Dashboard>('/api/dashboard'), api<SystemStatus>('/api/system/status')])
      .then(([d, s]) => {
        setData(d);
        setStatus(s);
      })
      .catch((e) => setError(e.message));
  };
  useEffect(load, []);

  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'Chào buổi sáng' : hour < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">{greeting},</p>
          <h1 className="text-3xl font-semibold tracking-tight">{user.name}</h1>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)} className="px-5 py-2.5">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.2}><path d="M12 5v14M5 12h14" /></svg>
          Bắt đầu hội nghị mới
        </Button>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {status && (!status.stt.configured || !status.translation.configured) && (
        <Card className="border-warn/30 p-4 text-sm">
          <span className="font-medium text-warn">Cần cấu hình API key.</span>{' '}
          <span className="text-muted">
            {!status.stt.configured && 'DEEPGRAM_API_KEY chưa có. '}
            {!status.translation.configured && 'ANTHROPIC_API_KEY chưa có. '}
            Thêm vào file <code className="font-mono text-fg">.env</code> ở thư mục gốc rồi khởi động lại server.{' '}
          </span>
          <Link href="/settings" className="text-electric hover:underline">Xem hướng dẫn</Link>
        </Card>
      )}

      {!data ? (
        !error && <div className="flex justify-center py-20 text-muted"><Spinner className="size-5" /></div>
      ) : (
        <>
          {data.active.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-medium tracking-[0.18em] text-faint uppercase">Phiên đang hoạt động</h2>
              <div className="grid gap-3 md:grid-cols-2">
                {data.active.map((c) => (
                  <Link key={c.id} href={`/conferences/${c.id}`}>
                    <Card className="flex items-center justify-between border-live/30 p-5 transition-colors hover:border-live/60">
                      <div>
                        <div className="font-medium">{c.name}</div>
                        <div className="text-sm text-muted">{c.location || 'Chưa có địa điểm'}</div>
                      </div>
                      <StatusPill status={c.status} />
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Hội nghị', value: data.stats.conferences.toLocaleString('vi-VN') },
              { label: 'Đoạn transcript', value: data.stats.segments.toLocaleString('vi-VN') },
              { label: 'Phút đã xử lý', value: data.stats.minutes.toFixed(1) },
              { label: 'Chi phí AI ước tính', value: `$${data.stats.cost.toFixed(2)}` },
            ].map((s, i) => (
              <motion.div key={s.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                <Card className="p-5">
                  <div className="text-xs text-faint">{s.label}</div>
                  <div className="mt-2 text-2xl font-semibold tabular-nums">{s.value}</div>
                </Card>
              </motion.div>
            ))}
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-medium tracking-[0.18em] text-faint uppercase">Hội nghị gần đây</h2>
              <Link href="/conferences" className="text-sm text-muted hover:text-fg">Xem tất cả →</Link>
            </div>
            {data.recent.length === 0 ? (
              <Card className="p-10 text-center">
                <div className="text-lg font-medium">Chưa có hội nghị nào</div>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted">Tạo hội nghị đầu tiên, chọn nguồn âm thanh và bắt đầu nghe. Bản gốc và bản dịch tiếng Việt sẽ được lưu tự động.</p>
                <Button variant="primary" className="mt-5" onClick={() => setCreating(true)}>Tạo hội nghị</Button>
              </Card>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {data.recent.map((c) => (
                  <Link key={c.id} href={`/conferences/${c.id}`}>
                    <Card className="h-full p-5 transition-colors hover:border-electric/50">
                      <div className="flex items-start justify-between gap-2">
                        <div className="line-clamp-2 font-medium">{c.name}</div>
                        <StatusPill status={c.status} />
                      </div>
                      <div className="mt-3 text-sm text-muted">
                        {c.starts_at ? new Date(c.starts_at).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }) : new Date(c.created_at).toLocaleDateString('vi-VN')}
                        {c.location && ` · ${c.location}`}
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Badge tone="cyan">{languageLabel(c.input_language)}</Badge>
                        <Badge>{c.segment_count ?? 0} đoạn</Badge>
                        {c.visibility === 'workspace' && <Badge>Chia sẻ</Badge>}
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      <NewConferenceDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
