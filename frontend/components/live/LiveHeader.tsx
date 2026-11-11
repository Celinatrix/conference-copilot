'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { RoomState, RoomStatus } from '@conference-copilot/shared';
import type { Conference } from '@/lib/api';
import type { ConnectionState } from '@/lib/live';
import { Badge, Button, ErrorBanner, Spinner, StatusPill } from '@/components/ui';
import { elapsed } from './parts';

const EXPORTS = [
  ['md', 'both', 'Markdown – gốc + tiếng Việt'],
  ['md', 'vi', 'Markdown – chỉ tiếng Việt'],
  ['txt', 'both', 'Văn bản – gốc + tiếng Việt'],
  ['txt', 'original', 'Văn bản – chỉ bản gốc'],
] as const;

const LEVEL_STEPS = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9];

function sttLabel(s: string) {
  return ({ connecting: 'đang kết nối', open: 'đang nghe', reconnecting: 'đang kết nối lại', closed: 'đã đóng', failed: 'lỗi' } as Record<string, string>)[s] ?? s;
}

function ConnBadge({ conn }: { conn: ConnectionState }) {
  if (conn === 'open') return <Badge tone="ok"><span className="size-1.5 rounded-full bg-ok" />Đã kết nối</Badge>;
  if (conn === 'closed') return <Badge>Ngắt kết nối</Badge>;
  return <Badge tone="warn"><Spinner className="size-2.5" />{conn === 'connecting' ? 'Đang kết nối' : 'Mất mạng – đang thử lại'}</Badge>;
}

export interface LiveHeaderProps {
  conference: Conference;
  userId: string;
  canManage: boolean;
  room: RoomState | null;
  status: RoomStatus;
  conn: ConnectionState;
  notice: string | null;
  onDismissNotice: () => void;
  capturing: boolean;
  level: number;
  queued: number;
  startedMs: number;
  someoneElseHosting: boolean;
  hasSegments: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onCopy: () => void;
  onOpenSettings: () => void;
}

/** Title, session controls, export menu and connection badges of the live page. */
export function LiveHeader(p: LiveHeaderProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const { conference, room, status } = p;
  const running = status === 'live' || status === 'paused';
  const pill = status === 'idle' ? (conference.status === 'draft' && !p.hasSegments ? 'draft' : 'ended') : status === 'ending' ? 'ended' : status;

  return (
    <header className="border-b border-line bg-navy/60 px-4 py-3 backdrop-blur sm:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-faint">
            <Link href="/conferences" className="hover:text-fg">Hội nghị</Link>
            <span>/</span>
            <button type="button" onClick={p.onOpenSettings} className="hover:text-fg">{conference.location || 'Thông tin'}</button>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="truncate text-lg font-semibold">{conference.name}</h1>
            <StatusPill status={pill} />
            {running && <span className="font-mono text-sm text-muted tabular-nums">{elapsed(p.startedMs)}</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {p.capturing && (
            <div className="flex h-8 w-16 items-end gap-0.5" role="img" aria-label="Mức âm thanh" title="Mức âm thanh đầu vào">
              {LEVEL_STEPS.map((th, i) => (
                <span key={th} className={`flex-1 rounded-sm transition-colors ${Math.sqrt(p.level) * 1.6 > th ? 'bg-cyan' : 'bg-line-strong'}`} style={{ height: `${30 + i * 14}%` }} />
              ))}
            </div>
          )}
          {p.canManage && !p.capturing && status !== 'ending' && (
            <Button variant="primary" onClick={p.onStart} disabled={p.someoneElseHosting || p.conn !== 'open'} title={p.someoneElseHosting ? 'Một thiết bị khác đang thu âm' : undefined}>
              <span className="size-2 rounded-full bg-white" />
              {status === 'paused' && room?.hostUserId === p.userId ? 'Tiếp tục trên thiết bị này' : 'Start Listening'}
            </Button>
          )}
          {p.capturing && status === 'live' && <Button onClick={p.onPause}>Pause</Button>}
          {p.capturing && status === 'paused' && <Button variant="primary" onClick={p.onResume}>Resume</Button>}
          {p.canManage && running && <Button variant="danger" onClick={p.onStop}>Stop Session</Button>}
          <div className="relative">
            <Button onClick={() => setExportOpen((o) => !o)} disabled={!p.hasSegments}>Export</Button>
            {exportOpen && (
              // biome-ignore lint/a11y/noStaticElementInteractions: closing on mouse-leave is a pointer convenience; the Export button toggles it for keyboard users.
              <div className="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-line-strong bg-panel p-1.5 shadow-xl" onMouseLeave={() => setExportOpen(false)}>
                {EXPORTS.map(([format, view, label]) => (
                  <a key={label} href={`/api/conferences/${conference.id}/export?format=${format}&view=${view}`} onClick={() => setExportOpen(false)} className="block rounded-lg px-3 py-2 text-sm text-muted hover:bg-panel-2 hover:text-fg">
                    {label}
                  </a>
                ))}
              </div>
            )}
          </div>
          <Button onClick={p.onCopy} disabled={!p.hasSegments}>Copy Translation</Button>
          {p.canManage && (
            <Button variant="subtle" onClick={p.onOpenSettings} aria-label="Thông tin hội nghị">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>
            </Button>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <ConnBadge conn={p.conn} />
        {room && room.sttStatus !== 'idle' && <Badge tone={room.sttStatus === 'open' ? 'ok' : 'warn'}>STT: {sttLabel(room.sttStatus)}</Badge>}
        {p.someoneElseHosting && <Badge tone="cyan">Đang xem bản dịch trực tiếp từ thiết bị khác</Badge>}
        {status === 'paused' && !room?.hostConnected && <Badge tone="warn">Thiết bị thu âm mất kết nối</Badge>}
        {p.queued > 5 && <Badge tone="warn">Đang giữ {(p.queued / 10).toFixed(0)}s âm thanh chờ gửi lại</Badge>}
        {room && <span className="text-faint">{room.viewers} người đang xem</span>}
      </div>
      {p.notice && <div className="mt-3"><ErrorBanner message={p.notice} onRetry={p.onDismissNotice} /></div>}
    </header>
  );
}
