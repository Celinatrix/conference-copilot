'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type User } from '@/lib/api';
import { ErrorBanner, Spinner } from './ui';

interface Session {
  user: User;
  workspace: { workspace_id: string; role: string; name: string } | null;
}

const SessionContext = createContext<Session | null>(null);
export const useSession = () => useContext(SessionContext)!;

const NAV = [
  { href: '/', label: 'Dashboard', icon: 'M3 12l9-8 9 8M5 10v10h14V10' },
  { href: '/conferences', label: 'Hội nghị & Lịch sử', icon: 'M4 6h16M4 12h16M4 18h10' },
  { href: '/settings', label: 'Cài đặt & Âm thanh', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z' },
];

const ROADMAP = ['Knowledge Base', 'AI Response Assistant', 'Tóm tắt hội nghị', 'Team Workspace'];

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative grid size-8 place-items-center rounded-lg bg-gradient-to-br from-electric to-cyan">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 text-white" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
          <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
        </svg>
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold tracking-tight">Conference Copilot</div>
        <div className="text-[10px] tracking-[0.18em] text-faint uppercase">Realtime AI</div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const load = () => {
    setError(null);
    api<Session>('/api/auth/me')
      .then(setSession)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace('/login');
        else setError(err.message);
      });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: load the session once on mount.
  useEffect(load, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the mobile menu whenever the route changes.
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
  };

  if (error) return <div className="mx-auto max-w-md p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!session)
    return (
      <div className="grid min-h-dvh place-items-center text-muted">
        <Spinner className="size-5" />
      </div>
    );

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  const nav = (
    <nav className="flex h-full flex-col gap-1 p-4">
      <div className="mb-6 px-2"><Logo /></div>
      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
            isActive(n.href) ? 'bg-electric/15 text-fg shadow-[inset_2px_0_0_var(--color-electric)]' : 'text-muted hover:bg-panel-2 hover:text-fg'
          }`}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d={n.icon} />
          </svg>
          {n.label}
        </Link>
      ))}
      <div className="mt-8 px-3 text-[10px] font-medium tracking-[0.18em] text-faint uppercase">Giai đoạn tiếp theo</div>
      <ul className="mt-2 space-y-1.5 px-3 text-xs text-faint">
        {ROADMAP.map((r) => (
          <li key={r} className="flex items-center gap-2"><span className="size-1 rounded-full bg-line-strong" />{r}</li>
        ))}
      </ul>
      <div className="mt-auto rounded-xl border border-line bg-navy/60 p-3">
        <div className="truncate text-sm font-medium">{session.user.name}</div>
        <div className="truncate text-xs text-faint">{session.user.email}</div>
        <button type="button" onClick={logout} className="mt-2 text-xs text-muted hover:text-fg">Đăng xuất</button>
      </div>
    </nav>
  );

  return (
    <SessionContext.Provider value={session}>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-line bg-navy/70 backdrop-blur lg:block">{nav}</aside>
        {menuOpen && (
          // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: backdrop click closes the menu; Escape does the same for keyboard users.
          <div className="fixed inset-0 z-40 bg-ink/70 lg:hidden" onClick={() => setMenuOpen(false)}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops the backdrop click from closing the menu. */}
            <aside className="h-full w-72 border-r border-line bg-navy" onClick={(e) => e.stopPropagation()}>{nav}</aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-line px-4 py-3 lg:hidden">
            <button type="button" onClick={() => setMenuOpen(true)} aria-label="Mở menu" className="rounded-md p-1.5 text-muted hover:bg-panel-2">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
            </button>
            <Logo />
          </header>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
