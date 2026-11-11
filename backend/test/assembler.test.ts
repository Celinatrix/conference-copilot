import { afterEach, describe, expect, it, vi } from 'vitest';
import { SentenceAssembler, type AssembledSegment } from '../src/live/assembler.js';
import type { SttResult } from '../src/live/stt.js';

const final = (text: string, startSec: number, endSec: number, over: Partial<SttResult> = {}): SttResult => ({
  isFinal: true, speechFinal: false, text, language: 'en', speaker: 'Speaker 1', startSec, endSec, confidence: 0.9, ...over,
});

function collect() {
  const out: AssembledSegment[] = [];
  return { out, asm: new SentenceAssembler((s) => out.push(s)) };
}

afterEach(() => vi.useRealTimers());

describe('SentenceAssembler', () => {
  it('joins mid-sentence finals and releases on the sentence end', () => {
    const { out, asm } = collect();
    asm.push(final('Our loss ratio', 0, 1.2));
    asm.push(final('improved this quarter', 1.2, 2.4));
    expect(out).toHaveLength(0);
    expect(asm.pendingText).toBe('Our loss ratio improved this quarter');
    asm.push(final('by four points.', 2.4, 3.3, { confidence: 0.5 }));
    expect(out).toEqual([
      { text: 'Our loss ratio improved this quarter by four points.', language: 'en', speaker: 'Speaker 1', startSec: 0, endSec: 3.3, confidence: 0.5 },
    ]);
    expect(asm.pendingText).toBe('');
  });

  it('does not cut on a short exclamation but does on speech_final', () => {
    const { out, asm } = collect();
    asm.push(final('OK.', 0, 0.4));
    expect(out).toHaveLength(0);
    asm.push(final('let us begin', 0.5, 1.2, { speechFinal: true }));
    expect(out.map((s) => s.text)).toEqual(['OK. let us begin']);
  });

  it('starts a new segment when the speaker changes', () => {
    const { out, asm } = collect();
    asm.push(final('Thank you for the question', 0, 1.5));
    asm.push(final('Could you elaborate', 1.6, 2.5, { speaker: 'Speaker 2' }));
    expect(out.map((s) => s.speaker)).toEqual(['Speaker 1']);
    asm.flush();
    expect(out.map((s) => s.text)).toEqual(['Thank you for the question', 'Could you elaborate']);
  });

  it('bounds unpunctuated speech by duration', () => {
    const { out, asm } = collect();
    for (let i = 0; i < 6; i++) asm.push(final('and then we looked at', i * 2.5, i * 2.5 + 2.5));
    expect(out).toHaveLength(1);
    expect(out[0].endSec - out[0].startSec).toBeGreaterThanOrEqual(12);
  });

  it('flushes after an idle gap and on utterance end', () => {
    vi.useFakeTimers();
    const { out, asm } = collect();
    asm.push(final('so the conclusion is', 0, 1));
    vi.advanceTimersByTime(1799);
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(out).toHaveLength(1);
    asm.push(final('next topic', 2, 3));
    asm.utteranceEnd();
    expect(out).toHaveLength(2);
  });

  it('picks the language that covers most of the text', () => {
    const { out, asm } = collect();
    asm.push(final('今日は', 0, 0.5, { language: 'ja' }));
    asm.push(final('we will discuss reserving methods', 0.5, 2, { language: 'en', speechFinal: true }));
    expect(out[0].language).toBe('en');
  });
});
