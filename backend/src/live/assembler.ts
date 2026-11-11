import type { SttResult } from './stt.js';

/** A complete sentence (or a bounded chunk of continuous speech) ready to be stored and translated. */
export interface AssembledSegment {
  text: string;
  language: string | null;
  speaker: string | null;
  startSec: number;
  endSec: number;
  /** Lowest confidence among the parts, so one badly heard fragment flags the whole sentence. */
  confidence: number | null;
}

export interface AssemblerOptions {
  /** Force a cut after this much continuous speech even without punctuation. */
  maxSeconds?: number;
  maxWords?: number;
  /** Flush when no new final text arrives for this long (provider never sent an end-of-utterance). */
  idleMs?: number;
  /** Below this many words a sentence-ending mark does not end the segment ("OK." "Yes."). */
  minWordsForPunctuationCut?: number;
}

const SENTENCE_END = /[.!?。！？]["')\]」』]?$/u;

/**
 * Speech-to-text providers finalise text in arbitrary chunks, often mid-sentence. Translating each chunk on
 * its own produces broken Vietnamese, so finals are collected here and released as whole sentences.
 */
export class SentenceAssembler {
  private parts: SttResult[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxSeconds: number;
  private readonly maxWords: number;
  private readonly idleMs: number;
  private readonly minWords: number;

  constructor(
    private readonly onSegment: (segment: AssembledSegment) => void,
    opts: AssemblerOptions = {},
  ) {
    this.maxSeconds = opts.maxSeconds ?? 12;
    this.maxWords = opts.maxWords ?? 60;
    this.idleMs = opts.idleMs ?? 1800;
    this.minWords = opts.minWordsForPunctuationCut ?? 4;
  }

  /** Text confirmed but not yet released, for showing the sentence as it grows. */
  get pendingText(): string {
    return this.parts.map((p) => p.text).join(' ');
  }

  get pendingSpeaker(): string | null {
    return this.parts[0]?.speaker ?? null;
  }

  get pendingLanguage(): string | null {
    return dominantLanguage(this.parts);
  }

  /** Feed a FINAL result. Interim results must not be passed here. */
  push(result: SttResult) {
    if (!result.text) {
      if (result.speechFinal) this.flush();
      return;
    }
    const first = this.parts[0];
    if (first && result.speaker && first.speaker && result.speaker !== first.speaker) this.flush();
    this.parts.push(result);

    const words = wordCount(this.pendingText);
    const span = result.endSec - this.parts[0].startSec;
    const endsSentence = SENTENCE_END.test(result.text) && words >= this.minWords;
    if (result.speechFinal || endsSentence || span >= this.maxSeconds || words >= this.maxWords) {
      this.flush();
    } else {
      this.armIdle();
    }
  }

  /** Provider reported the end of an utterance (silence gap). */
  utteranceEnd() {
    this.flush();
  }

  flush() {
    this.clearIdle();
    if (!this.parts.length) return;
    const parts = this.parts;
    this.parts = [];
    const confidences = parts.map((p) => p.confidence).filter((c): c is number => c !== null);
    this.onSegment({
      text: parts.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim(),
      language: dominantLanguage(parts),
      speaker: parts[0].speaker,
      startSec: parts[0].startSec,
      endSec: parts[parts.length - 1].endSec,
      confidence: confidences.length ? Math.min(...confidences) : null,
    });
  }

  dispose() {
    this.clearIdle();
    this.parts = [];
  }

  private armIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.flush(), this.idleMs);
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function wordCount(text: string): number {
  // CJK scripts have no spaces; count characters there so long Japanese/Chinese sentences are still bounded.
  const cjk = text.match(/[぀-ヿ㐀-鿿가-힯]/g)?.length ?? 0;
  const spaced = text.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').split(/\s+/).filter(Boolean).length;
  return spaced + Math.ceil(cjk / 2);
}

function dominantLanguage(parts: SttResult[]): string | null {
  const weight = new Map<string, number>();
  for (const p of parts) if (p.language) weight.set(p.language, (weight.get(p.language) ?? 0) + p.text.length);
  let best: string | null = null;
  let max = 0;
  for (const [lang, w] of weight) if (w > max) [best, max] = [lang, w];
  return best;
}
