'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type SystemStatus } from '@/lib/api';
import { AudioCapture, captureSupport, describeMediaError, listInputDevices, requestMicPermission } from '@/lib/audio';
import { Badge, Button, Card, ErrorBanner, Field, Spinner, inputClass } from '@/components/ui';

export default function SettingsPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<SystemStatus>('/api/system/status').then(setStatus).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-8 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">Cài đặt & Thiết lập âm thanh</h1>
      {error && <ErrorBanner message={error} />}

      <section className="space-y-3">
        <h2 className="text-xs font-medium tracking-[0.18em] text-faint uppercase">Dịch vụ AI</h2>
        {!status ? (
          !error && <Spinner />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <ServiceCard title="Speech-to-Text" name={`Deepgram · ${status.stt.model}`} ok={status.stt.configured} envVar="DEEPGRAM_API_KEY" />
            <ServiceCard title="Dịch realtime" name={`Anthropic · ${status.translation.model}`} ok={status.translation.configured} envVar="ANTHROPIC_API_KEY" />
          </div>
        )}
        <p className="text-xs text-faint">
          API key chỉ nằm trong file <code className="font-mono">.env</code> của server, không bao giờ được gửi xuống trình duyệt. Cơ sở dữ liệu: {status?.database ?? '…'}.
        </p>
      </section>

      <MicTest />

      <section className="space-y-3">
        <h2 className="text-xs font-medium tracking-[0.18em] text-faint uppercase">Hướng dẫn chọn nguồn âm thanh</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Guide title="1. Dây từ bàn mixer (tốt nhất)" tone="ok">
            Xin ban kỹ thuật một đường <b>line-out / aux-out</b> từ bàn mixer hội trường, cắm vào <b>USB audio interface</b> (VD: Focusrite, Behringer UCA) rồi cắm vào laptop. Chọn interface đó trong danh sách micro. Âm thanh sạch nhất, không có tiếng vang phòng.
          </Guide>
          <Guide title="2. Micro rời / micro điện thoại">
            Đặt micro gần loa hoặc bục diễn giả, tránh gần điều hòa. Có thể mở ứng dụng này trên điện thoại làm thiết bị thu âm, các thành viên khác xem bản dịch trên máy của mình.
          </Guide>
          <Guide title="3. Âm thanh hệ thống (hội nghị online)">
            Chọn <b>“Âm thanh hệ thống”</b>, trình duyệt sẽ hỏi chia sẻ màn hình. Trên <b>Chrome/Edge Windows</b>: chọn “Toàn màn hình” hoặc một tab và bật <b>“Chia sẻ âm thanh”</b>. Trên <b>macOS</b>: chỉ chia sẻ được âm thanh của một tab Chrome. Safari, Firefox và điện thoại hiện không hỗ trợ.
          </Guide>
          <Guide title="4. Quyền & thông báo ghi âm" tone="warn">
            Trước mỗi phiên, ứng dụng yêu cầu bạn xác nhận đã được phép ghi âm theo quy định của ban tổ chức. Âm thanh thô <b>không được lưu</b>, chỉ lưu văn bản transcript và bản dịch.
          </Guide>
        </div>
      </section>
    </div>
  );
}

function ServiceCard({ title, name, ok, envVar }: { title: string; name: string; ok: boolean; envVar: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <div className="text-xs text-faint">{title}</div>
        {ok ? <Badge tone="ok">Đã cấu hình</Badge> : <Badge tone="warn">Chưa có key</Badge>}
      </div>
      <div className="mt-2 font-medium">{name}</div>
      {!ok && <div className="mt-2 text-xs text-muted">Thêm <code className="font-mono text-fg">{envVar}=…</code> vào .env rồi khởi động lại server.</div>}
    </Card>
  );
}

function Guide({ title, children, tone }: { title: string; children: React.ReactNode; tone?: 'ok' | 'warn' }) {
  const border = tone === 'ok' ? 'border-ok/25' : tone === 'warn' ? 'border-warn/25' : '';
  return (
    <Card className={`p-5 ${border}`}>
      <div className="font-medium">{title}</div>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </Card>
  );
}

function MicTest() {
  const support = typeof window !== 'undefined' ? captureSupport() : null;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [level, setLevel] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capture = useRef<AudioCapture | null>(null);

  useEffect(() => () => capture.current?.stop(), []);

  const start = async () => {
    setError(null);
    try {
      await requestMicPermission();
      const list = await listInputDevices();
      setDevices(list);
      const chosen = deviceId || list[0]?.deviceId || '';
      setDeviceId(chosen);
      const c = new AudioCapture();
      c.onLevel = (rms) => setLevel(rms);
      c.onEnded = (reason) => {
        setError(reason);
        stop();
      };
      await c.start({ kind: 'device', deviceId: chosen, label: '' });
      capture.current = c;
      setRunning(true);
    } catch (err) {
      setError(describeMediaError(err));
    }
  };

  const stop = () => {
    capture.current?.stop();
    capture.current = null;
    setRunning(false);
    setLevel(0);
  };

  const pct = Math.min(100, Math.round(Math.sqrt(level) * 160));
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-medium tracking-[0.18em] text-faint uppercase">Kiểm tra micro</h2>
      <Card className="space-y-4 p-5">
        {support && !support.secureContext && <ErrorBanner message="Trình duyệt chỉ cho thu âm trên HTTPS hoặc localhost." />}
        {error && <ErrorBanner message={error} />}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-60 flex-1">
            <Field label="Thiết bị">
              <select
                className={inputClass}
                value={deviceId}
                onChange={(e) => {
                  setDeviceId(e.target.value);
                  if (running) stop();
                }}
              >
                {devices.length === 0 && <option value="">Bấm “Kiểm tra” để xem danh sách thiết bị</option>}
                {devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Micro ${i + 1}`}</option>
                ))}
              </select>
            </Field>
          </div>
          {running ? <Button onClick={stop}>Dừng</Button> : <Button variant="primary" onClick={start}>Kiểm tra</Button>}
        </div>
        <div>
          <div className="h-2.5 overflow-hidden rounded-full bg-navy">
            <div className="h-full rounded-full bg-gradient-to-r from-electric to-cyan transition-[width] duration-100" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-2 text-xs text-faint">
            {running ? (pct < 8 ? 'Tín hiệu rất yếu: đưa micro lại gần nguồn âm.' : pct > 90 ? 'Tín hiệu quá lớn, có thể bị méo.' : 'Mức tín hiệu tốt.') : 'Âm thanh chỉ được đo trên máy bạn, không gửi đi đâu.'}
          </p>
        </div>
      </Card>
    </section>
  );
}
