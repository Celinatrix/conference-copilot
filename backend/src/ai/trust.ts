/**
 * Cheap, deterministic checks that tell the reader WHERE not to trust a line, without another model call:
 * a badly heard segment, a number that did not survive translation, or a glossary term translated off-script.
 * Flags are strings so they store and render without a schema: 'low_confidence', 'number:12.5', 'term:IBNR'.
 */

export interface GlossaryEntry {
  term: string;
  /** Required rendering in Vietnamese; when absent the term must appear unchanged. */
  vi: string | null;
}

export function parseGlossary(glossary: string): GlossaryEntry[] {
  return glossary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [term, ...rest] = line.split('=');
      const vi = rest.join('=').trim();
      return { term: term.trim(), vi: vi || null };
    })
    .filter((e) => e.term.length > 1);
}

/** Numbers as digit strings with separators removed, so "1,200.5" (en) matches "1.200,5" (vi). */
export function numberKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d.,]*\d|\d/g)) {
    const raw = m[0];
    const digits = raw.replace(/[.,]/g, '');
    // Single digits are often spelled out in Vietnamese ("ba điểm"); only check numbers that carry precision.
    if (digits.length < 2 && !/[.,]/.test(raw) && !/%/.test(text.slice(m.index! + raw.length, m.index! + raw.length + 2))) continue;
    out.push(digits);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function computeFlags(input: {
  original: string;
  vi: string | null;
  confidence: number | null;
  glossary: string;
  lowConfidenceThreshold: number;
}): string[] {
  const flags: string[] = [];
  if (input.confidence !== null && input.confidence < input.lowConfidenceThreshold) flags.push('low_confidence');
  if (!input.vi) return flags;

  const translated = new Set(numberKeys(input.vi));
  for (const n of new Set(numberKeys(input.original))) {
    if (!translated.has(n)) flags.push(`number:${n}`);
  }

  const viLower = input.vi.toLowerCase();
  for (const entry of parseGlossary(input.glossary)) {
    const inOriginal = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(entry.term)}($|[^\\p{L}\\p{N}])`, 'iu').test(input.original);
    if (!inOriginal) continue;
    const expected = (entry.vi ?? entry.term).toLowerCase();
    if (!viLower.includes(expected)) flags.push(`term:${entry.term}`);
  }
  return flags;
}
