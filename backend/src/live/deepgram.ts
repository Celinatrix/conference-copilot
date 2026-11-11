import WebSocket from 'ws';
import { BYTES_PER_SECOND, SAMPLE_RATE, type SttHandlers, type SttProvider, type SttResult, type SttStream } from './stt.js';

/** Max audio held while the upstream socket is reconnecting. */
const MAX_BUFFER_BYTES = BYTES_PER_SECOND * 30;
const KEEPALIVE_IDLE_MS = 4000;

export type DeepgramMessage =
  | { kind: 'result'; result: SttResult }
  | { kind: 'utterance_end' }
  | { kind: 'error'; message: string }
  | { kind: 'other'; type: string };

function majority<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** Parses one Deepgram streaming message. `offsetSec` shifts timestamps across reconnects. */
export function parseDeepgramMessage(raw: string, offsetSec = 0): DeepgramMessage {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: 'error', message: 'Invalid JSON from Deepgram' };
  }
  if (msg.type === 'UtteranceEnd') return { kind: 'utterance_end' };
  if (msg.type === 'Error' || msg.err_code) {
    return { kind: 'error', message: msg.description || msg.err_msg || msg.message || 'Deepgram error' };
  }
  if (msg.type !== 'Results') return { kind: 'other', type: String(msg.type ?? 'unknown') };

  const alt = msg.channel?.alternatives?.[0] ?? {};
  const words: any[] = Array.isArray(alt.words) ? alt.words : [];
  const speaker = majority(words.map((w) => w.speaker).filter((s) => typeof s === 'number'));
  const language =
    majority(words.map((w) => w.language).filter((l) => typeof l === 'string')) ??
    (Array.isArray(alt.languages) && typeof alt.languages[0] === 'string' ? alt.languages[0] : null);
  const start = Number(msg.start ?? 0);
  const duration = Number(msg.duration ?? 0);
  return {
    kind: 'result',
    result: {
      isFinal: Boolean(msg.is_final),
      speechFinal: Boolean(msg.speech_final),
      text: String(alt.transcript ?? '').trim(),
      language,
      speaker: speaker === null ? null : `Speaker ${speaker + 1}`,
      startSec: offsetSec + start,
      endSec: offsetSec + start + duration,
      confidence: typeof alt.confidence === 'number' ? alt.confidence : null,
    },
  };
}

export function buildDeepgramUrl(model: string, language: string): string {
  const params = new URLSearchParams({
    model,
    language,
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    diarize: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
  });
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

class DeepgramStream implements SttStream {
  readonly provider = 'deepgram';
  private ws: WebSocket | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private bytesTotal = 0;
  /** Bytes delivered to connections that have since closed; becomes the timestamp offset of the next one. */
  private bytesBeforeCurrent = 0;
  private bytesCurrent = 0;
  private lastSendAt = Date.now();
  private attempts = 0;
  private finishing = false;
  private closed = false;
  private finishResolve: (() => void) | null = null;
  private keepAliveTimer: NodeJS.Timeout;

  constructor(
    private apiKey: string,
    private url: string,
    private handlers: SttHandlers,
  ) {
    this.connect();
    this.keepAliveTimer = setInterval(() => {
      if (Date.now() - this.lastSendAt > KEEPALIVE_IDLE_MS) this.keepAlive();
    }, 2000);
  }

  private connect() {
    this.handlers.onStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.url, { headers: { Authorization: `Token ${this.apiKey}` } });
    this.ws = ws;
    const offsetSec = this.bytesBeforeCurrent / BYTES_PER_SECOND;

    ws.on('open', () => {
      this.attempts = 0;
      this.handlers.onStatus('open');
      for (const chunk of this.pending) this.deliver(chunk);
      this.pending = [];
      this.pendingBytes = 0;
      if (this.finishing) ws.send(JSON.stringify({ type: 'CloseStream' }));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const parsed = parseDeepgramMessage(data.toString(), offsetSec);
      if (parsed.kind === 'result') this.handlers.onResult(parsed.result);
      else if (parsed.kind === 'utterance_end') this.handlers.onUtteranceEnd?.();
      else if (parsed.kind === 'error') this.handlers.onStatus('reconnecting', parsed.message);
    });

    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const fatal = code === 400 || code === 401 || code === 403;
        const detail = `Deepgram HTTP ${code}${body ? `: ${body.slice(0, 300)}` : ''}`;
        if (fatal) {
          this.closed = true;
          this.handlers.onStatus('failed', detail);
          this.finishResolve?.();
        } else {
          this.scheduleReconnect(detail);
        }
      });
    });

    ws.on('error', () => {
      // 'close' follows; reconnect decisions live there.
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.bytesBeforeCurrent += this.bytesCurrent;
      this.bytesCurrent = 0;
      this.ws = null;
      if (this.finishing || this.closed) {
        this.closed = true;
        this.handlers.onStatus('closed');
        this.finishResolve?.();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(detail?: string) {
    if (this.closed) return;
    this.attempts++;
    this.handlers.onStatus('reconnecting', detail);
    const delay = Math.min(500 * 2 ** (this.attempts - 1), 8000);
    setTimeout(() => {
      if (!this.closed && !this.ws) this.connect();
    }, delay);
  }

  private deliver(chunk: Buffer) {
    this.ws!.send(chunk);
    this.bytesTotal += chunk.length;
    this.bytesCurrent += chunk.length;
    this.lastSendAt = Date.now();
  }

  send(chunk: Buffer) {
    if (this.closed || this.finishing) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.deliver(chunk);
      return;
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    while (this.pendingBytes > MAX_BUFFER_BYTES && this.pending.length) {
      this.pendingBytes -= this.pending.shift()!.length;
    }
  }

  keepAlive() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      this.lastSendAt = Date.now();
    }
  }

  finish(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.finishing = true;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.close();
        resolve();
      }, 5000);
      this.finishResolve = () => {
        clearTimeout(timer);
        clearInterval(this.keepAliveTimer);
        resolve();
      };
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      else if (!this.ws) this.close();
    });
  }

  close() {
    this.closed = true;
    clearInterval(this.keepAliveTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.finishResolve?.();
  }

  audioSecondsSent() {
    return this.bytesTotal / BYTES_PER_SECOND;
  }
}

export class DeepgramProvider implements SttProvider {
  readonly name = 'deepgram';
  constructor(
    private apiKey: string | null,
    private model: string,
  ) {}

  get configured() {
    return Boolean(this.apiKey);
  }

  open(opts: { language: string }, handlers: SttHandlers): SttStream {
    if (!this.apiKey) throw new Error('DEEPGRAM_API_KEY chưa được cấu hình trong file backend/.env');
    return new DeepgramStream(this.apiKey, buildDeepgramUrl(this.model, opts.language), handlers);
  }
}
