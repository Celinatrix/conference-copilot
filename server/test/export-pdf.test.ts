import { describe, expect, it } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import { buildTranscriptPdf } from '../src/export-pdf.js';
import type { SegmentDto } from '../src/live/protocol.js';

const segment = (seq: number, original: string, vi: string | null, extra: Partial<SegmentDto> = {}): SegmentDto => ({
  id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
  conference_id: 'c',
  session_id: 's1',
  seq,
  start_ms: seq * 4000,
  end_ms: seq * 4000 + 3000,
  speaker: 'Speaker 1',
  language: 'en',
  confidence: 0.95,
  text_original: original,
  text_vi: vi,
  translation_status: vi ? 'done' : 'pending',
  translation_error: null,
  is_important: false,
  edited: false,
  flags: [],
  created_at: '2026-11-19T00:00:00Z',
  updated_at: '2026-11-19T00:00:00Z',
  ...extra,
});

async function textOf(pdf: Uint8Array) {
  const proxy = await getDocumentProxy(pdf);
  const { text, totalPages } = await extractText(proxy, { mergePages: true });
  return { text: String(text), totalPages };
}

describe('transcript PDF', () => {
  const conference = { name: 'Chung kết InsuNovate', location: 'UEH', starts_at: '2026-11-19T08:00:00Z' };

  it('keeps Vietnamese diacritics (embedded font) and the chosen view', async () => {
    const segments = [
      segment(1, 'Why did you choose a 60% quota share with Gen Re?', 'Tại sao nhóm chọn tái bảo hiểm theo tỷ lệ 60% với Gen Re?', { is_important: true }),
      segment(2, 'How did you estimate Home Recovery frequency?', 'Nhóm ước tính tần suất Phục hồi tại nhà như thế nào?'),
    ];
    const both = await textOf(await buildTranscriptPdf(conference, segments, 'both'));
    expect(both.text).toContain('Chung kết InsuNovate');
    expect(both.text).toContain('Tại sao nhóm chọn tái bảo hiểm');
    expect(both.text).toContain('Why did you choose a 60% quota share');
    expect(both.text).toContain('Quan trọng');

    const viOnly = await textOf(await buildTranscriptPdf(conference, segments, 'vi'));
    expect(viOnly.text).toContain('Phục hồi tại nhà');
    expect(viOnly.text).not.toContain('How did you estimate');
  });

  it('wraps long text and flows onto further pages with page numbers', async () => {
    const long = 'Tỷ lệ mất hiệu lực năm đầu ảnh hưởng mạnh tới giá trị kinh doanh mới. '.repeat(12);
    const segments = Array.from({ length: 40 }, (_, i) => segment(i + 1, `Question number ${i + 1} about lapse`, long));
    const pdf = await buildTranscriptPdf(conference, segments, 'both');
    const { text, totalPages } = await textOf(pdf);
    expect(totalPages).toBeGreaterThan(3);
    expect(text).toContain(`Trang 1/${totalPages}`);
    expect(text).toContain('Question number 40 about lapse');
    // Subsetting keeps the file small despite the embedded font.
    expect(pdf.byteLength).toBeLessThan(600_000);
  });

  it('handles an empty transcript', async () => {
    const { text, totalPages } = await textOf(await buildTranscriptPdf(conference, [], 'both'));
    expect(totalPages).toBe(1);
    expect(text).toContain('Chưa có nội dung transcript');
  });
});
