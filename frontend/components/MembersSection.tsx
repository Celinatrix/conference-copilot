'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, ErrorBanner, Field, Spinner, inputClass } from './ui';

interface Member {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
}
interface Invite {
  id: string;
  role: 'admin' | 'member';
  email: string | null;
  expires_at: string;
  created_by_name: string;
}

const roleLabel = { owner: 'Owner', admin: 'Admin', member: 'Thành viên' } as const;

export function MembersSection() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [myRole, setMyRole] = useState<Member['role'] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ role: 'member' as Invite['role'], email: '', expiresInDays: 7 });
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canInvite = myRole === 'owner' || myRole === 'admin';

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ workspace: { role: Member['role'] }; members: Member[] }>('/api/workspace/members');
      setMembers(r.members);
      setMyRole(r.workspace.role);
      if (r.workspace.role !== 'member') setInvites((await api<{ invites: Invite[] }>('/api/workspace/invites')).invites);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được danh sách thành viên');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const create = async () => {
    setCreating(true);
    setError(null);
    setLink(null);
    setCopied(false);
    try {
      const r = await api<{ path: string }>('/api/workspace/invites', {
        method: 'POST',
        json: { role: form.role, expiresInDays: form.expiresInDays, ...(form.email.trim() ? { email: form.email.trim() } : {}) },
      });
      setLink(`${window.location.origin}${r.path}`);
      setForm((f) => ({ ...f, email: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tạo được lời mời');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm('Thu hồi lời mời này? Link sẽ không dùng được nữa.')) return;
    try {
      await api(`/api/workspace/invites/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thu hồi được');
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-xs font-medium tracking-[0.18em] text-faint uppercase">Thành viên & lời mời</h2>
      {error && <ErrorBanner message={error} onRetry={load} />}
      <Card className="divide-y divide-line">
        {!members ? (
          <div className="p-5 text-muted"><Spinner /></div>
        ) : (
          members.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{m.name}</div>
                <div className="truncate text-xs text-faint">{m.email}</div>
              </div>
              <Badge tone={m.role === 'owner' ? 'cyan' : 'default'}>{roleLabel[m.role]}</Badge>
            </div>
          ))
        )}
      </Card>

      {canInvite && (
        <Card className="space-y-4 p-5">
          <div className="text-sm font-medium">Mời thành viên mới</div>
          <p className="text-xs text-faint">
            Đăng ký công khai đã tắt. Người mới chỉ tham gia được bằng link mời. Mỗi link dùng một lần, hết hạn theo số ngày bạn chọn, và chỉ hiển thị một lần ngay sau khi tạo.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Vai trò">
              <select className={inputClass} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Invite['role'] })}>
                <option value="member">Thành viên</option>
                {myRole === 'owner' && <option value="admin">Admin</option>}
              </select>
            </Field>
            <Field label="Chỉ cho email (tùy chọn)">
              <input className={inputClass} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="ten@congty.com" />
            </Field>
            <Field label="Hết hạn sau">
              <select className={inputClass} value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: Number(e.target.value) })}>
                {[1, 3, 7, 14].map((d) => <option key={d} value={d}>{d} ngày</option>)}
              </select>
            </Field>
          </div>
          <Button variant="primary" onClick={create} loading={creating}>Tạo link mời</Button>
          {link && (
            <div className="space-y-2 rounded-xl border border-ok/30 bg-ok/5 p-3">
              <div className="text-xs text-muted">Gửi link này cho người được mời. Link chỉ hiện lần này; nếu mất, hãy thu hồi và tạo link mới.</div>
              <div className="flex gap-2">
                <input className={`${inputClass} font-mono text-xs`} readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Link mời" />
                <Button onClick={copy}>{copied ? 'Đã chép' : 'Sao chép'}</Button>
              </div>
            </div>
          )}
          {invites.length > 0 && (
            <div>
              <div className="mb-2 text-xs text-faint">Lời mời đang chờ</div>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {invites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <span>
                      {roleLabel[i.role]}
                      {i.email ? ` · ${i.email}` : ' · ai có link'}
                      <span className="text-xs text-faint"> · hết hạn {new Date(i.expires_at).toLocaleDateString('vi-VN')} · tạo bởi {i.created_by_name}</span>
                    </span>
                    <Button variant="subtle" className="px-2 py-1 text-xs" onClick={() => revoke(i.id)}>Thu hồi</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </section>
  );
}
