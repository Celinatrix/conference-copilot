import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { SegmentDto } from './live/protocol.js';
import { formatClock, type ExportView } from './export.js';

/*
 * Transcript as a PDF. The 14 standard PDF fonts have no Vietnamese diacritics, so Be Vietnam Pro (OFL, the same
 * typeface as the web UI) is embedded; only the glyphs actually used are kept, which keeps files small.
 */

const require = createRequire(import.meta.url);
const FONT_DIR = '@expo-google-fonts/be-vietnam-pro';
let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
function fontBytes() {
  fontCache ??= {
    regular: readFileSync(require.resolve(`${FONT_DIR}/400Regular/BeVietnamPro_400Regular.ttf`)),
    bold: readFileSync(require.resolve(`${FONT_DIR}/700Bold/BeVietnamPro_700Bold.ttf`)),
  };
  return fontCache;
}

// A4 in points, with comfortable margins for printing.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 60;
const MARGIN_BOTTOM = 64;
const TEXT_W = PAGE_W - MARGIN_X * 2;

const INK = rgb(0.09, 0.11, 0.15);
const MUTED = rgb(0.42, 0.46, 0.53);
const ACCENT = rgb(0.06, 0.6, 0.72);
const RULE = rgb(0.85, 0.87, 0.9);

/** Splits text into lines no wider than `width`; very long words are broken by character. */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      // A single word wider than the column (URLs, long numbers): cut it.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

export async function buildTranscriptPdf(
  conference: { name: string; location: string; starts_at: string | Date | null },
  segments: SegmentDto[],
  view: ExportView,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bytes = fontBytes();
  const regular = await doc.embedFont(bytes.regular, { subset: true });
  const bold = await doc.embedFont(bytes.bold, { subset: true });
  doc.setTitle(conference.name);
  doc.setCreator('Conference AI Copilot');
  doc.setProducer('Conference AI Copilot');

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN_TOP;

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN_TOP;
  };
  /** Starts a new page unless `height` more points fit on this one. */
  const ensure = (height: number) => {
    if (y - height < MARGIN_BOTTOM) newPage();
  };
  const writeLines = (lines: string[], font: PDFFont, size: number, color = INK, indent = 0, leading = 1.45) => {
    for (const line of lines) {
      ensure(size * leading);
      y -= size * leading;
      page.drawText(line, { x: MARGIN_X + indent, y, size, font, color });
    }
  };

  // Title block.
  writeLines(wrapText(conference.name, bold, 20, TEXT_W), bold, 20, INK, 0, 1.3);
  const when = conference.starts_at ? new Date(conference.starts_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
  const viewLabel = view === 'both' ? 'Bản gốc + bản dịch tiếng Việt' : view === 'vi' ? 'Bản dịch tiếng Việt' : 'Bản gốc';
  const meta = [when, conference.location, viewLabel, `${segments.length} đoạn`].filter(Boolean).join('  ·  ');
  writeLines(wrapText(meta, regular, 9.5, TEXT_W), regular, 9.5, MUTED);
  y -= 10;
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: PAGE_W - MARGIN_X, y }, thickness: 0.8, color: RULE });
  y -= 8;

  if (!segments.length) writeLines(['Chưa có nội dung transcript.'], regular, 11, MUTED);

  let session = '';
  let sessionIndex = 0;
  for (const s of segments) {
    if (s.session_id !== session) {
      session = s.session_id;
      sessionIndex++;
      ensure(40);
      y -= 14;
      writeLines([`Phiên ${sessionIndex}`], bold, 12.5, INK);
      y -= 2;
    }

    const head = [formatClock(s.start_ms), s.speaker, s.language?.toUpperCase(), s.is_important ? '★ Quan trọng' : null].filter(Boolean).join('  ·  ');
    const original = view !== 'vi' ? wrapText(s.text_original, regular, 10.5, TEXT_W - 12) : [];
    const viText = s.text_vi ?? (s.translation_status === 'error' ? '(chưa dịch được)' : s.translation_status === 'skipped' ? s.text_original : '(đang dịch)');
    const vi = view !== 'original' ? wrapText(viText, view === 'both' ? bold : regular, 11, TEXT_W - 12) : [];

    // Keep a segment's header with at least its first line.
    ensure(8.5 * 1.45 + 11 * 1.45 + 6);
    const top = y;
    y -= 6;
    writeLines([head], regular, 8.5, s.is_important ? ACCENT : MUTED, 12);
    if (original.length) writeLines(original, regular, 10.5, view === 'both' ? MUTED : INK, 12);
    if (vi.length) writeLines(vi, view === 'both' ? bold : regular, 11, INK, 12);
    // Marker bar for starred segments (drawn on the page where the segment ends, when it does not split).
    if (s.is_important && top > y) page.drawRectangle({ x: MARGIN_X, y, width: 2.5, height: top - y - 4, color: ACCENT });
    y -= 6;
  }

  // Footer on every page.
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `${conference.name.slice(0, 70)}  ·  Trang ${i + 1}/${pages.length}`;
    p.drawText(label, { x: MARGIN_X, y: 32, size: 8, font: regular, color: MUTED });
    p.drawText('Conference AI Copilot', { x: PAGE_W - MARGIN_X - regular.widthOfTextAtSize('Conference AI Copilot', 8), y: 32, size: 8, font: regular, color: MUTED });
  });

  return doc.save();
}
