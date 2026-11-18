import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export interface Pcm {
  samples: Int16Array;
  sampleRate: number;
}

export type TtsStatus =
  | { state: 'unsupported'; message: string }
  | { state: 'starting' }
  | { state: 'ready'; voice: string }
  | { state: 'no_voice'; message: string }
  | { state: 'failed'; message: string };

const SCRIPT = fileURLToPath(new URL('./windows-tts.ps1', import.meta.url));
const SYNTH_TIMEOUT_MS = 20_000;

const fromB64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

/** Reads a 16-bit PCM WAV (as produced by Windows speech) into mono samples. */
export function parseWav(buf: Buffer): Pcm {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let pos = 12;
  let channels = 1;
  let sampleRate = 0;
  let bits = 16;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (buf.readUInt16LE(body) !== 1) throw new Error('WAV is not PCM');
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16 || !sampleRate) throw new Error('unsupported WAV format');
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = buf.readInt16LE(body + i * 2 * channels); // first channel
      return { samples, sampleRate };
    }
    pos = body + size + (size % 2);
  }
  throw new Error('WAV has no data');
}

/**
 * Text-to-speech through the voices installed in Windows, using one long-lived PowerShell worker.
 * Free and offline; Vietnamese needs the "Vietnamese" speech pack installed in Windows settings.
 */
export class WindowsTts {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (p: Pcm) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  status: TtsStatus;

  constructor(
    private lang: string,
    private rate: number,
    private log: { warn(o: object, m?: string): void },
  ) {
    this.status = process.platform === 'win32' ? { state: 'starting' } : { state: 'unsupported', message: 'Đọc qua luồng âm thanh chỉ chạy khi server chạy trên Windows.' };
  }

  /** Starts the worker (once) and resolves when a voice is ready; rejects when none can be used. */
  start(): Promise<void> {
    if (this.status.state === 'unsupported') return Promise.reject(new Error(this.status.message));
    if (this.ready) return this.ready;
    this.status = { state: 'starting' };
    this.ready = new Promise<void>((resolve, reject) => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Lang', this.lang, '-Rate', String(this.rate)], {
        windowsHide: true,
      });
      this.proc = proc;
      let started = false;
      const fail = (message: string) => {
        this.status = { state: 'failed', message };
        this.ready = null;
        this.proc = null;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(message));
        }
        this.pending.clear();
        if (!started) reject(new Error(message));
      };
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      proc.on('error', (err) => fail(`Không chạy được PowerShell: ${err.message}`));
      proc.on('exit', (code) => {
        if (this.status.state === 'no_voice') return;
        fail(`Bộ đọc giọng nói dừng (mã ${code}). ${stderr.trim().slice(0, 300)}`);
      });
      createInterface({ input: proc.stdout }).on('line', (line) => {
        const [head, a, b] = line.split(' ');
        if (head === 'READY') {
          started = true;
          this.status = { state: 'ready', voice: fromB64(a ?? '') };
          resolve();
        } else if (head === 'NOVOICE') {
          started = true;
          const installed = fromB64(a ?? '') || 'không có';
          this.status = {
            state: 'no_voice',
            message: `Windows chưa có giọng đọc "${this.lang}". Giọng đang có: ${installed}. Cài: Settings → Time & Language → Speech → Add voices → Vietnamese, rồi khởi động lại server.`,
          };
          this.ready = null;
          reject(new Error(this.status.message));
        } else {
          const p = this.pending.get(head);
          if (!p) return;
          this.pending.delete(head);
          clearTimeout(p.timer);
          try {
            if (a === 'OK') p.resolve(parseWav(Buffer.from(b ?? '', 'base64')));
            else p.reject(new Error(fromB64(b ?? '') || 'Lỗi đọc giọng nói'));
          } catch (err) {
            p.reject(err as Error);
          }
        }
      });
    });
    return this.ready;
  }

  async synthesize(text: string): Promise<Pcm> {
    await this.start();
    const proc = this.proc;
    if (!proc) throw new Error('Bộ đọc giọng nói chưa sẵn sàng');
    const id = String(this.nextId++);
    return new Promise<Pcm>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Đọc giọng nói quá lâu'));
      }, SYNTH_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      // One line per request: newlines inside the text would break the protocol, base64 keeps it on one line.
      proc.stdin.write(`${id} ${Buffer.from(text.replace(/\s+/g, ' ').trim(), 'utf8').toString('base64')}\n`);
    });
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}
