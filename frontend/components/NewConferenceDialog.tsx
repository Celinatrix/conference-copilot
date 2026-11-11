'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, LANGUAGES, type Conference } from '@/lib/api';
import { Button, Dialog, ErrorBanner, Field, inputClass } from './ui';

export function NewConferenceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    starts_at: '',
    location: '',
    speakers: '',
    input_language: 'multi',
    glossary: '',
    visibility: 'private' as 'private' | 'workspace',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { conference } = await api<{ conference: Conference }>('/api/conferences', {
        method: 'POST',
        json: { ...form, starts_at: form.starts_at ? new Date(form.starts_at).toISOString() : null },
      });
      router.push(`/conferences/${conference.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tạo được hội nghị');
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Hội nghị mới" wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <Field label="Tên hội nghị">
          <input className={inputClass} required autoFocus value={form.name} onChange={set('name')} placeholder="VD: Asia AI Summit 2026 – Keynote" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ngày giờ">
            <input type="datetime-local" className={inputClass} value={form.starts_at} onChange={set('starts_at')} />
          </Field>
          <Field label="Địa điểm">
            <input className={inputClass} value={form.location} onChange={set('location')} placeholder="Hội trường A, Singapore" />
          </Field>
        </div>
        <Field label="Diễn giả" hint="Mỗi người một dòng hoặc cách nhau bằng dấu phẩy.">
          <input className={inputClass} value={form.speakers} onChange={set('speakers')} placeholder="Dr. Jane Lee, Kenji Tanaka" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ngôn ngữ đầu vào" hint="Nếu chỉ có một ngôn ngữ, chọn cụ thể để nhận diện chính xác hơn.">
            <select className={inputClass} value={form.input_language} onChange={set('input_language')}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Quyền riêng tư">
            <select className={inputClass} value={form.visibility} onChange={set('visibility')}>
              <option value="private">Riêng tư – chỉ mình tôi</option>
              <option value="workspace">Chia sẻ với workspace</option>
            </select>
          </Field>
        </div>
        <Field label="Thuật ngữ / Glossary" hint="Tên riêng, thuật ngữ cần giữ nguyên hoặc dịch theo cách cụ thể. VD: inference = suy luận">
          <textarea className={`${inputClass} min-h-20`} value={form.glossary} onChange={set('glossary')} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="subtle" onClick={onClose}>Hủy</Button>
          <Button type="submit" variant="primary" loading={loading}>Tạo và mở phòng live</Button>
        </div>
      </form>
    </Dialog>
  );
}
