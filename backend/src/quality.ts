/** Helpers for measuring recognition and translation quality against reference recordings. */

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s%.]/gu, ' ')
    .replace(/(\d)\.(\d)/g, '$1DOT$2')
    .replace(/\./g, ' ')
    .replace(/DOT/g, '.')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate = (substitutions + deletions + insertions) / reference words. */
export function wordErrorRate(reference: string, hypothesis: string): { wer: number; refWords: number; errors: number } {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (!ref.length) return { wer: hyp.length ? 1 : 0, refWords: 0, errors: hyp.length };
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  const errors = prev[hyp.length];
  return { wer: errors / ref.length, refWords: ref.length, errors };
}

/** Share of glossary terms (one per line, "term" or "term = translation") that the recognizer heard verbatim. */
export function termRecall(glossary: string, transcript: string): { found: string[]; missed: string[] } {
  const terms = glossary
    .split('\n')
    .map((l) => l.split('=')[0].trim())
    .filter(Boolean);
  const hay = normalizeWords(transcript).join(' ');
  const found: string[] = [];
  const missed: string[] = [];
  for (const t of terms) (hay.includes(normalizeWords(t).join(' ')) ? found : missed).push(t);
  return { found, missed };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Reads a 16 kHz mono 16-bit PCM WAV and returns the raw samples. */
export function readPcm16Wav(file: Buffer): Buffer {
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let offset = 12;
  let format: { channels: number; rate: number; bits: number; codec: number } | null = null;
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = { codec: file.readUInt16LE(body), channels: file.readUInt16LE(body + 2), rate: file.readUInt32LE(body + 4), bits: file.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!format || format.codec !== 1 || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16) {
        throw new Error(
          `WAV must be 16 kHz mono 16-bit PCM (got ${format ? `${format.rate} Hz, ${format.channels} ch, ${format.bits}-bit` : 'no fmt chunk'}). ` +
            'Convert with: ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le output.wav',
        );
      }
      return file.subarray(body, Math.min(body + size, file.length));
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
