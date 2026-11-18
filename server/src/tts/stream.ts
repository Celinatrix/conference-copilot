import type { ServerResponse } from 'node:http';
import { Mp3Stream, resample } from './mp3.js';
import type { WindowsTts } from './windows.js';

export const STREAM_RATE = 24_000;
const KBPS = 48;
const TICK_MS = 100;
/** Speech waiting longer than this is dropped from the front so listeners hear what is said now. */
const MAX_BACKLOG_SAMPLES = STREAM_RATE * 15;
/** A listener this far behind (slow phone network) is disconnected rather than buffered without bound. */
const MAX_LISTENER_BUFFER = 512 * 1024;

/**
 * One endless MP3 stream per conference, paced in real time like internet radio: speech when there is a
 * translation to read, silence otherwise. A phone plays it as ordinary media, which keeps going with the
 * screen locked (unlike in-page speech synthesis, which stops).
 */
class ConferenceStream {
  readonly listeners = new Set<ServerResponse>();
  private queue: Int16Array[] = [];
  private queued = 0;
  private enc = new Mp3Stream(STREAM_RATE, KBPS);
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private sent = 0;

  add(res: ServerResponse) {
    this.listeners.add(res);
    if (!this.timer) {
      this.startedAt = Date.now();
      this.sent = 0;
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }
  }

  remove(res: ServerResponse) {
    this.listeners.delete(res);
    if (this.listeners.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.queue = [];
      this.queued = 0;
    }
  }

  enqueue(pcm: Int16Array) {
    if (!this.listeners.size || !pcm.length) return;
    this.queue.push(pcm);
    this.queued += pcm.length;
    while (this.queued > MAX_BACKLOG_SAMPLES && this.queue.length > 1) this.queued -= this.queue.shift()!.length;
  }

  private tick() {
    // Wall-clock pacing: interval drift never makes the stream run fast or slow.
    const due = Math.floor(((Date.now() - this.startedAt) / 1000) * STREAM_RATE) - this.sent;
    if (due <= 0) return;
    const out = new Int16Array(due);
    let filled = 0;
    while (filled < due && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(head.length, due - filled);
      out.set(head.subarray(0, take), filled);
      filled += take;
      this.queued -= take;
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    this.sent += due;
    const mp3 = this.enc.encode(out);
    if (!mp3.length) return;
    for (const res of this.listeners) {
      if (res.writableLength > MAX_LISTENER_BUFFER) {
        res.destroy();
        this.remove(res);
        continue;
      }
      res.write(mp3);
    }
  }
}

export class AudioService {
  private streams = new Map<string, ConferenceStream>();

  constructor(
    readonly tts: WindowsTts,
    private log: { warn(o: object, m?: string): void },
  ) {}

  private stream(conferenceId: string) {
    let s = this.streams.get(conferenceId);
    if (!s) {
      s = new ConferenceStream();
      this.streams.set(conferenceId, s);
    }
    return s;
  }

  listen(conferenceId: string, res: ServerResponse) {
    const s = this.stream(conferenceId);
    s.add(res);
    res.on('close', () => {
      s.remove(res);
      if (!s.listeners.size) this.streams.delete(conferenceId);
    });
  }

  listenerCount(conferenceId: string) {
    return this.streams.get(conferenceId)?.listeners.size ?? 0;
  }

  /** Reads text into the conference stream; does nothing (and costs nothing) when nobody is listening. */
  async say(conferenceId: string, text: string | null) {
    const clean = (text ?? '').replace(/\((suy luận|inference)\)/gi, '').trim();
    if (!clean || !this.listenerCount(conferenceId)) return;
    try {
      const pcm = await this.tts.synthesize(clean);
      this.streams.get(conferenceId)?.enqueue(resample(pcm.samples, pcm.sampleRate, STREAM_RATE));
    } catch (err) {
      this.log.warn({ err, conferenceId }, 'speech synthesis failed');
    }
  }
}
