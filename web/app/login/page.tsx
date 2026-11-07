'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { api } from '@/lib/api';
import { Logo } from '@/components/AppShell';
import { Button, ErrorBanner, Field, inputClass } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', name: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api(`/api/auth/${mode}`, {
        method: 'POST',
        json: mode === 'login' ? { email: form.email, password: form.password } : form,
      });
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Có lỗi xảy ra');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden border-r border-line lg:flex lg:flex-col lg:justify-between lg:p-12">
        <Logo />
        <div className="max-w-lg">
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-4xl leading-tight font-semibold tracking-tight"
          >
            Nghe mọi ngôn ngữ.
            <br />
            <span className="bg-gradient-to-r from-electric to-cyan bg-clip-text text-transparent">Hiểu bằng tiếng Việt.</span>
          </motion.h1>
          <p className="mt-5 text-muted">
            Phiên dịch hội nghị theo thời gian thực: nhận diện giọng nói, tự động phát hiện ngôn ngữ và dịch sang tiếng Việt chỉ sau khoảng một đến hai giây.
          </p>
          <div className="mt-10 space-y-3 rounded-2xl border border-line bg-panel/60 p-5 font-mono text-[13px]">
            <div className="flex gap-3"><span className="text-faint">00:12:41</span><span className="text-cyan">EN</span><span className="text-muted">Our latency dropped by 38 percent.</span></div>
            <div className="flex gap-3"><span className="text-faint">00:12:41</span><span className="text-electric">VI</span><span>Độ trễ của chúng tôi giảm <span className="num-hl">38%</span>.</span></div>
          </div>
          <p className="mt-2 text-xs text-faint">Minh họa giao diện</p>
        </div>
        <div className="text-xs text-faint">Dữ liệu hội nghị được mã hóa khi truyền và chỉ hiển thị với người được cấp quyền.</div>
      </section>

      <section className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div className="lg:hidden"><Logo /></div>
          <div>
            <h2 className="text-2xl font-semibold">{mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}</h2>
            <p className="mt-1 text-sm text-muted">
              {mode === 'login' ? 'Chào mừng trở lại.' : 'Tài khoản đầu tiên sẽ là chủ sở hữu workspace.'}
            </p>
          </div>
          {error && <ErrorBanner message={error} />}
          {mode === 'register' && (
            <Field label="Họ tên">
              <input className={inputClass} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
            </Field>
          )}
          <Field label="Email">
            <input className={inputClass} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
          </Field>
          <Field label="Mật khẩu" hint={mode === 'register' ? 'Ít nhất 10 ký tự.' : undefined}>
            <input
              className={inputClass}
              type="password"
              required
              minLength={mode === 'register' ? 10 : undefined}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </Field>
          <Button type="submit" variant="primary" loading={loading} className="w-full py-2.5">
            {mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </Button>
          <p className="text-center text-sm text-muted">
            {mode === 'login' ? 'Chưa có tài khoản?' : 'Đã có tài khoản?'}{' '}
            <button type="button" className="font-medium text-electric hover:underline" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>
              {mode === 'login' ? 'Đăng ký' : 'Đăng nhập'}
            </button>
          </p>
        </form>
      </section>
    </div>
  );
}
