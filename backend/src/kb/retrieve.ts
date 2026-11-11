import type { Queryable } from '../db.js';

export interface ContextChunk {
  id: string;
  document_id: string;
  filename: string;
  locator: string;
  ordinal: number;
  content: string;
}

/** About 15k tokens of source text per answer: enough for several documents, cheap with prompt caching. */
export const CONTEXT_BUDGET_CHARS = 60_000;

/** Distinct search terms (letters/digits only, so they are always valid tsquery lexemes). */
export function searchTerms(texts: string[], max = 40): string[] {
  const stop = new Set(['the', 'and', 'for', 'are', 'you', 'your', 'what', 'how', 'why', 'can', 'could', 'would', 'this', 'that', 'with', 'của', 'và', 'là', 'có', 'không', 'những', 'các', 'cho', 'được', 'trong', 'một', 'gì', 'nào', 'sao', 'thế', 'đã', 'sẽ', 'này', 'đó', 'với', 'về']);
  const out: string[] = [];
  for (const text of texts) {
    for (const raw of text.toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u)) {
      // Vietnamese syllables are short ("dự", "lỗ"); keep 2-letter words that carry diacritics.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the range means "any non-ASCII character", not a control character.
      const minLength = /[^\x00-\x7f]/.test(raw) ? 2 : 3;
      if (raw.length < minLength || stop.has(raw) || out.includes(raw)) continue;
      out.push(raw);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Chooses the document text an answer is grounded on. Small knowledge bases are sent whole (the model then
 * sees everything and cannot miss a passage); larger ones are narrowed by keyword rank across both the
 * original question and its Vietnamese translation, so a question asked in English still finds Vietnamese text.
 */
export async function selectContext(
  db: Queryable,
  conferenceId: string,
  queries: string[],
  budgetChars = CONTEXT_BUDGET_CHARS,
): Promise<{ chunks: ContextChunk[]; mode: 'all' | 'ranked' | 'none' }> {
  const [{ total }] = await db.query<{ total: number | null }>(
    `SELECT SUM(length(c.content))::int AS total FROM document_chunks c
     JOIN documents d ON d.id = c.document_id AND d.status = 'ready' WHERE c.conference_id = $1`,
    [conferenceId],
  );
  if (!total) return { chunks: [], mode: 'none' };

  const columns = `c.id, c.document_id, d.filename, c.locator, c.ordinal, c.content`;
  if (total <= budgetChars) {
    const chunks = await db.query<ContextChunk>(
      `SELECT ${columns} FROM document_chunks c JOIN documents d ON d.id = c.document_id AND d.status = 'ready'
       WHERE c.conference_id = $1 ORDER BY d.created_at, c.ordinal`,
      [conferenceId],
    );
    return { chunks, mode: 'all' };
  }

  const terms = searchTerms(queries);
  if (!terms.length) return { chunks: [], mode: 'none' };
  const ranked = await db.query<ContextChunk & { rank: number }>(
    `SELECT ${columns}, ts_rank_cd(c.tsv, q) AS rank
     FROM document_chunks c JOIN documents d ON d.id = c.document_id AND d.status = 'ready',
          to_tsquery('simple', $2) q
     WHERE c.conference_id = $1 AND c.tsv @@ q
     ORDER BY rank DESC LIMIT 60`,
    [conferenceId, terms.join(' | ')],
  );
  const picked: ContextChunk[] = [];
  let used = 0;
  for (const { rank: _rank, ...chunk } of ranked) {
    if (used + chunk.content.length > budgetChars) continue;
    picked.push(chunk);
    used += chunk.content.length;
  }
  // Present passages in reading order so neighbouring chunks read as continuous text.
  picked.sort((a, b) => (a.document_id === b.document_id ? a.ordinal - b.ordinal : a.document_id.localeCompare(b.document_id)));
  return { chunks: picked, mode: picked.length ? 'ranked' : 'none' };
}
