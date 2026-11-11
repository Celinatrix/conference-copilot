/** Provider-neutral streaming speech-to-text contract. Audio is 16 kHz mono PCM16 little-endian. */

export const SAMPLE_RATE = 16000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

export interface SttResult {
  isFinal: boolean;
  /** Provider signals the speaker paused (end of utterance). */
  speechFinal: boolean;
  text: string;
  language: string | null;
  speaker: string | null;
  /** Seconds relative to the start of the logical session (across reconnects). */
  startSec: number;
  endSec: number;
  confidence: number | null;
}

export type SttStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';

export interface SttHandlers {
  onResult(result: SttResult): void;
  onStatus(status: SttStatus, detail?: string): void;
  /** Provider detected a silence gap after speech. Optional: not every provider emits it. */
  onUtteranceEnd?(): void;
}

export interface SttStream {
  readonly provider: string;
  send(chunk: Buffer): void;
  /** Keep the upstream connection alive while no audio flows (pause). */
  keepAlive(): void;
  /** Flush pending audio and wait for the last final results. */
  finish(): Promise<void>;
  close(): void;
  /** Total seconds of audio delivered upstream, used for cost tracking. */
  audioSecondsSent(): number;
}

export interface SttProvider {
  readonly name: string;
  readonly configured: boolean;
  open(opts: { language: string }, handlers: SttHandlers): SttStream;
}
