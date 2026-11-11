import { describe, expect, it } from 'vitest';
import { percentile, readPcm16Wav, termRecall, wordErrorRate } from '../src/quality.js';

function wav(rate: number, channels: number, samples: number): Buffer {
  const data = Buffer.alloc(samples * 2 * channels);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2 * channels, 28);
  h.writeUInt16LE(2 * channels, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe('quality metrics', () => {
  it('computes word error rate ignoring case and punctuation', () => {
    expect(wordErrorRate('The loss ratio is 94.5%.', 'the loss ratio is 94.5%').wer).toBe(0);
    const r = wordErrorRate('chain ladder method works well', 'chain letter method works');
    expect(r).toEqual({ wer: 0.4, refWords: 5, errors: 2 });
  });

  it('measures glossary term recall', () => {
    expect(termRecall('IBNR = dự phòng IBNR\nchain ladder\nSolvency II', 'our IBNR reserve uses the chain ladder')).toEqual({
      found: ['IBNR', 'chain ladder'],
      missed: ['Solvency II'],
    });
  });

  it('takes percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([], 95)).toBeNull();
  });

  it('accepts only 16 kHz mono PCM WAV', () => {
    expect(readPcm16Wav(wav(16000, 1, 160)).length).toBe(320);
    expect(() => readPcm16Wav(wav(48000, 2, 10))).toThrow(/ffmpeg/);
  });
});
