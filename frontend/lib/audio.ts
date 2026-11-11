export type AudioSource = { kind: 'device'; deviceId: string; label: string } | { kind: 'system'; label: string };

export function captureSupport() {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return {
    microphone: Boolean(md?.getUserMedia) && typeof AudioWorkletNode !== 'undefined',
    system: Boolean(md?.getDisplayMedia),
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
  };
}

/** Lists audio inputs. Labels are only exposed after the user has granted microphone permission once. */
export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

export async function requestMicPermission() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const t of s.getTracks()) t.stop();
}

export function describeMediaError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'Trình duyệt bị từ chối quyền thu âm. Hãy bấm biểu tượng ổ khóa trên thanh địa chỉ và cho phép Microphone.';
    case 'NotFoundError':
      return 'Không tìm thấy thiết bị thu âm. Kiểm tra micro hoặc USB audio interface đã cắm chưa.';
    case 'NotReadableError':
      return 'Thiết bị thu âm đang bị ứng dụng khác chiếm dụng (Zoom, Teams…).';
    case 'OverconstrainedError':
      return 'Thiết bị đã chọn không còn khả dụng. Hãy chọn lại nguồn âm thanh.';
    default:
      return err instanceof Error ? err.message : 'Không mở được nguồn âm thanh.';
  }
}

export class AudioCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;

  onChunk: (pcm: ArrayBuffer) => void = () => {};
  onLevel: (rms: number) => void = () => {};
  /** Fired when the browser ends the capture (device unplugged, user stopped screen share). */
  onEnded: (reason: string) => void = () => {};

  async start(source: AudioSource) {
    if (source.kind === 'system') {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (this.stream.getAudioTracks().length === 0) {
        this.stop();
        throw new Error('Không nhận được âm thanh hệ thống. Khi chia sẻ, hãy chọn tab/màn hình và bật "Chia sẻ âm thanh" (Share audio).');
      }
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: source.deviceId ? { exact: source.deviceId } : undefined,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    }

    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener('ended', () =>
        this.onEnded(source.kind === 'system' ? 'Đã dừng chia sẻ âm thanh hệ thống.' : 'Thiết bị thu âm đã bị ngắt kết nối.'),
      );
    }

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('/pcm-worklet.js');
    const input = this.ctx.createMediaStreamSource(new MediaStream(this.stream.getAudioTracks()));
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture', { processorOptions: { targetRate: 16000 } });
    this.node.port.onmessage = (e: MessageEvent<{ type: string; buffer: ArrayBuffer; level: number }>) => {
      if (e.data.type !== 'chunk') return;
      this.onLevel(e.data.level);
      this.onChunk(e.data.buffer);
    };
    // A muted sink keeps the graph pulling audio through the worklet without playing it back.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    input.connect(this.node).connect(sink).connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  stop() {
    this.node?.port.close();
    this.node?.disconnect();
    void this.ctx?.close().catch(() => {});
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.node = null;
    this.ctx = null;
    this.stream = null;
  }
}
