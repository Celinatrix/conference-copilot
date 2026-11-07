import { BYTES_PER_SECOND } from './stt.js';

/**
 * Speech-to-text timestamps count only the audio that was sent. With silence gating (VAD) or pauses, audio time
 * runs slower than the clock, so "00:12:00" in the transcript would not match the session. This maps audio time
 * back to session time using checkpoints recorded whenever the stream had a gap.
 */
export class AudioTimeline {
  private checkpoints: { audioSec: number; wallMs: number }[] = [];
  private audioBytes = 0;

  constructor(private readonly startedAt: number) {}

  /** Call for every chunk forwarded upstream, BEFORE counting it. */
  mark(chunkBytes: number, now = Date.now()) {
    const audioSec = this.audioBytes / BYTES_PER_SECOND;
    const wallMs = now - this.startedAt;
    const last = this.checkpoints.at(-1);
    const expected = last ? last.wallMs + (audioSec - last.audioSec) * 1000 : 0;
    // A gap of more than half a second means audio was withheld (silence, pause, reconnect).
    if (!last || wallMs - expected > 500) this.checkpoints.push({ audioSec, wallMs });
    this.audioBytes += chunkBytes;
  }

  toSessionMs(audioSec: number): number {
    let cp = this.checkpoints[0];
    if (!cp) return Math.round(audioSec * 1000);
    for (const c of this.checkpoints) {
      if (c.audioSec > audioSec) break;
      cp = c;
    }
    return Math.round(cp.wallMs + (audioSec - cp.audioSec) * 1000);
  }
}
