import { describe, expect, it } from 'vitest';
import { looksLikeQuestion } from '../src/ai/questions.js';
import { buildDocumentBlocks, parseAnswer } from '../src/ai/responder.js';
import { computeFlags, numberKeys, parseGlossary } from '../src/ai/trust.js';
import { normalizeModes } from '../src/ai/service.js';
import { AudioTimeline } from '../src/live/timeline.js';
import type { ContextChunk } from '../src/kb/retrieve.js';

describe('looksLikeQuestion', () => {
  it('accepts punctuated and unpunctuated questions in several languages', () => {
    expect(looksLikeQuestion('What is your loss ratio target for next year?')).toBe(true);
    expect(looksLikeQuestion('how do you validate the model')).toBe(true);
    expect(looksLikeQuestion('Pourquoi avez-vous choisi cette méthode')).toBe(true);
    expect(looksLikeQuestion('この方法の限界は何ですか')).toBe(true);
    expect(looksLikeQuestion('Tại sao dự phòng lại tăng')).toBe(true);
  });
  it('rejects statements and fragments', () => {
    expect(looksLikeQuestion('Our loss ratio improved by four points.')).toBe(false);
    expect(looksLikeQuestion('OK?')).toBe(false);
  });
});

const chunk = (id: string, doc: string, locator: string): ContextChunk => ({ id, document_id: doc, filename: `${doc}.pdf`, locator, ordinal: 0, content: `text ${id}` });

describe('Smart Response parsing', () => {
  const chunks = [chunk('c1', 'd1', 'trang 3'), chunk('c2', 'd1', 'trang 4'), chunk('c3', 'd2', 'slide 2')];

  it('builds one citable document per file with cache on the last block', () => {
    const { blocks, map } = buildDocumentBlocks(chunks);
    expect(blocks).toHaveLength(2);
    expect(map.map((m) => m.map((c) => c.id))).toEqual([['c1', 'c2'], ['c3']]);
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
    expect((blocks[0].source as { content: { text: string }[] }).content[0].text).toBe('[trang 3] text c1');
  });

  it('splits sections and attaches citations to the option they appear in', () => {
    const { map } = buildDocumentBlocks(chunks);
    const pieces = [
      { text: '[[ANALYSIS]]\nHọ muốn biết lý do.\n[[OPTION professional]]\n[[VI]]\nTỷ lệ tổn thất là ' },
      { text: '62%', citations: [{ type: 'content_block_location', document_index: 0, start_block_index: 0, end_block_index: 1, cited_text: 'Loss ratio 62%' }] },
      { text: '.\n[[EN]]\nThe loss ratio was 62%.\n[[OPTION concise]]\n[[VI]]\nKết quả trên ' },
      { text: 'slide', citations: [{ type: 'content_block_location', document_index: 1, start_block_index: 0, end_block_index: 1, cited_text: 'Results' }] },
      { text: '.\n[[EN]]\nSee the results.\n[[MISSING]]\nKhông có\n[[FOLLOWUP]]\n- Which years? / Những năm nào?\n- Gross or net? / Gộp hay ròng?' },
    ];
    const a = parseAnswer(pieces, map, ['professional', 'concise']);
    expect(a.analysis_vi).toBe('Họ muốn biết lý do.');
    expect(a.options.map((o) => o.mode)).toEqual(['professional', 'concise']);
    expect(a.options[0].vi).toBe('Tỷ lệ tổn thất là 62%.');
    expect(a.options[0].en).toBe('The loss ratio was 62%.');
    expect(a.options[0].citations).toEqual([{ chunk_id: 'c1', document_id: 'd1', filename: 'd1.pdf', locator: 'trang 3', quote: 'Loss ratio 62%' }]);
    expect(a.options[1].citations.map((c) => c.locator)).toEqual(['slide 2']);
    expect(a.missing).toBe('');
    expect(a.follow_ups).toEqual(['Which years? / Những năm nào?', 'Gross or net? / Gộp hay ròng?']);
  });

  it('keeps an unstructured reply instead of dropping it', () => {
    const a = parseAnswer([{ text: 'Không đủ căn cứ trong tài liệu.' }], [], ['concise']);
    expect(a.options).toEqual([{ mode: 'concise', vi: 'Không đủ căn cứ trong tài liệu.', en: '', citations: [] }]);
  });

  it('caps response modes at three and falls back to the default set', () => {
    expect(normalizeModes(['academic', 'technical', 'concise', 'strategic'])).toEqual(['academic', 'technical', 'concise']);
    expect(normalizeModes(['bogus'])).toEqual(['professional', 'concise', 'strategic']);
  });
});

describe('trust flags', () => {
  const base = { glossary: '', lowConfidenceThreshold: 0.75 };

  it('normalises numbers across locales and ignores bare single digits', () => {
    expect(numberKeys('Premium of 1,200.5 rose 12% in 2025, 3 lines')).toEqual(['12005', '12', '2025']);
    expect(numberKeys('Phí 1.200,5 tăng 12% năm 2025')).toEqual(['12005', '12', '2025']);
  });

  it('flags low confidence, dropped numbers and off-glossary terms', () => {
    expect(computeFlags({ ...base, original: 'Loss ratio 62% in 2025', vi: 'Tỷ lệ tổn thất 62% năm 2025', confidence: 0.9 })).toEqual([]);
    expect(computeFlags({ ...base, original: 'Loss ratio 62%', vi: 'Tỷ lệ tổn thất 26%', confidence: 0.5 })).toEqual(['low_confidence', 'number:62']);
    const glossary = 'IBNR\nloss ratio = tỷ lệ tổn thất';
    expect(computeFlags({ ...base, glossary, original: 'The IBNR and loss ratio rose', vi: 'Dự phòng và tỷ lệ bồi thường tăng', confidence: null })).toEqual(['term:IBNR', 'term:loss ratio']);
  });

  it('parses glossary lines and skips comments', () => {
    expect(parseGlossary('# terms\nIBNR\nchain ladder = phương pháp chain ladder\n')).toEqual([
      { term: 'IBNR', vi: null },
      { term: 'chain ladder', vi: 'phương pháp chain ladder' },
    ]);
  });
});

describe('AudioTimeline', () => {
  it('maps audio time to session time across silence gaps', () => {
    const t = new AudioTimeline(0);
    const chunk = 3200; // 100 ms
    let now = 0;
    for (let i = 0; i < 20; i++) t.mark(chunk, (now += 100)); // 2 s of speech from t=0.1 s
    now += 5000; // 5 s withheld by the silence gate
    for (let i = 0; i < 10; i++) t.mark(chunk, (now += 100));
    expect(t.toSessionMs(1)).toBe(1100);
    expect(t.toSessionMs(2.5)).toBe(7600);
  });
});
