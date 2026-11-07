'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';

const variants: Record<Variant, string> = {
  primary:
    'bg-electric text-white shadow-[0_8px_24px_-8px_rgb(59_108_255/0.7)] hover:bg-[#4d7bff] disabled:bg-electric/40 disabled:shadow-none',
  ghost: 'border border-line-strong text-fg hover:border-electric/60 hover:bg-panel-2 disabled:opacity-40',
  danger: 'border border-live/40 text-live hover:bg-live/10 disabled:opacity-40',
  subtle: 'text-muted hover:text-fg hover:bg-panel-2 disabled:opacity-40',
};

export function Button({
  variant = 'ghost',
  loading,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} aria-hidden />;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-panel/80 backdrop-blur-sm ${className}`}>{children}</div>;
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'live' | 'ok' | 'warn' | 'cyan' }) {
  const tones = {
    default: 'border-line-strong text-muted',
    live: 'border-live/40 bg-live/10 text-live',
    ok: 'border-ok/30 bg-ok/10 text-ok',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    cyan: 'border-cyan/30 bg-cyan/10 text-cyan',
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-live/30 bg-live/10 px-4 py-3 text-sm text-[#ffb3c0]">
      <span>{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 font-medium text-fg underline-offset-2 hover:underline">
          Thử lại
        </button>
      )}
    </div>
  );
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/70 p-0 backdrop-blur-sm sm:items-center sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal
            aria-label={title}
            className={`max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-line-strong bg-panel p-6 shadow-2xl sm:rounded-2xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          >
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{title}</h2>
              <button onClick={onClose} aria-label="Đóng" className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-fg">
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-line-strong bg-navy px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-electric focus:outline-none focus:ring-2 focus:ring-electric/25';

export function StatusPill({ status }: { status: string }) {
  if (status === 'live')
    return (
      <Badge tone="live">
        <span className="live-dot size-1.5 rounded-full bg-live" /> LIVE
      </Badge>
    );
  if (status === 'paused') return <Badge tone="warn">Tạm dừng</Badge>;
  if (status === 'ended') return <Badge>Đã kết thúc</Badge>;
  return <Badge>Bản nháp</Badge>;
}
