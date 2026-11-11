import JSZip from 'jszip';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { extractText, getDocumentProxy } from 'unpdf';

export type DocumentKind = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv';

/** One addressable unit of a source document (page, slide, sheet section) before chunking. */
export interface SourceUnit {
  locator: string;
  text: string;
}

export interface ParsedDocument {
  kind: DocumentKind;
  units: SourceUnit[];
  unitCount: number;
  warning: string | null;
}

export interface Chunk {
  ordinal: number;
  locator: string;
  content: string;
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CHUNK_CHARS = 1500;
const ROWS_PER_CHUNK = 40;

export function detectKind(filename: string): DocumentKind | null {
  const ext = filename.toLowerCase().split('.').pop();
  return ext === 'pdf' || ext === 'docx' || ext === 'pptx' || ext === 'xlsx' || ext === 'csv' ? ext : null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping NUL bytes from extracted text is the point.
const clean = (s: string) => s.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

async function parsePdf(buf: Buffer): Promise<ParsedDocument> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((t, i) => ({ locator: `trang ${i + 1}`, text: clean(t) }));
  const withText = pages.filter((p) => p.text.length > 20);
  const warning =
    withText.length === 0
      ? 'Không đọc được chữ trong PDF này (có thể là bản scan). Hãy dùng bản PDF có chữ chọn được.'
      : withText.length < totalPages / 2
        ? `Chỉ ${withText.length}/${totalPages} trang có chữ đọc được; các trang scan bị bỏ qua.`
        : null;
  return { kind: 'pdf', units: withText, unitCount: totalPages, warning };
}

async function parseDocx(buf: Buffer): Promise<ParsedDocument> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  // Word files have no stable page numbers; cite by section number instead.
  const paragraphs = value.split(/\n\s*\n/).map(clean).filter(Boolean);
  const units: SourceUnit[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length > CHUNK_CHARS) {
      units.push({ locator: `phần ${units.length + 1}`, text: current });
      current = '';
    }
    current = current ? `${current}\n\n${p}` : p;
  }
  if (current) units.push({ locator: `phần ${units.length + 1}`, text: current });
  return { kind: 'docx', units, unitCount: units.length, warning: units.length ? null : 'Tài liệu Word không có chữ.' };
}

function xmlText(xml: string): string {
  // Each <a:p> is a paragraph; <a:t> holds the runs of text.
  return xml
    .split(/<\/a:p>/)
    .map((para) => [...para.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join(''))
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

async function parsePptx(buf: Buffer): Promise<ParsedDocument> {
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  const units: SourceUnit[] = [];
  for (const file of slideFiles) {
    const n = Number(file.match(/(\d+)\.xml$/)![1]);
    let text = xmlText(await zip.file(file)!.async('string'));
    const notes = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    if (notes) {
      const noteText = xmlText(await notes.async('string')).replace(/^\d+$/m, '').trim();
      if (noteText) text += `\n[Ghi chú người thuyết trình] ${noteText}`;
    }
    if (clean(text)) units.push({ locator: `slide ${n}`, text: clean(text) });
  }
  return { kind: 'pptx', units, unitCount: slideFiles.length, warning: units.length ? null : 'Slide không có chữ.' };
}

function rowsToUnits(sheet: string, header: string[], rows: string[][]): SourceUnit[] {
  const units: SourceUnit[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_CHUNK) {
    const slice = rows.slice(i, i + ROWS_PER_CHUNK);
    // Header repeated in every chunk so each one is understandable on its own when cited.
    const lines = [header.join(' | '), ...slice.map((r) => r.join(' | '))];
    const first = i + 2;
    units.push({ locator: `${sheet}, dòng ${first}–${first + slice.length - 1}`, text: lines.join('\n') });
  }
  return units;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue);
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return String(value.text);
    return '';
  }
  return String(value);
}

async function parseXlsx(buf: Buffer): Promise<ParsedDocument> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const units: SourceUnit[] = [];
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText);
      if (values.some((v) => v.trim())) rows.push(values);
    });
    if (rows.length) units.push(...rowsToUnits(`sheet ${ws.name}`, rows[0], rows.slice(1)));
  });
  return { kind: 'xlsx', units, unitCount: wb.worksheets.length, warning: units.length ? null : 'Bảng tính trống.' };
}

function parseCsv(buf: Buffer): ParsedDocument {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const { data } = Papa.parse<string[]>(text, { skipEmptyLines: true });
  if (!data.length) return { kind: 'csv', units: [], unitCount: 0, warning: 'File CSV trống.' };
  return { kind: 'csv', units: rowsToUnits('CSV', data[0], data.slice(1)), unitCount: 1, warning: null };
}

export async function parseDocument(buf: Buffer, filename: string): Promise<ParsedDocument> {
  const kind = detectKind(filename);
  switch (kind) {
    case 'pdf':
      return parsePdf(buf);
    case 'docx':
      return parseDocx(buf);
    case 'pptx':
      return parsePptx(buf);
    case 'xlsx':
      return parseXlsx(buf);
    case 'csv':
      return parseCsv(buf);
    default:
      throw new Error('Chỉ hỗ trợ PDF, DOCX, PPTX, XLSX, CSV.');
  }
}

/** Splits long units into ~1,500-character chunks on paragraph/line boundaries, keeping each unit's locator. */
export function chunkUnits(units: SourceUnit[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const unit of units) {
    if (unit.text.length <= CHUNK_CHARS) {
      chunks.push({ ordinal: chunks.length, locator: unit.locator, content: unit.text });
      continue;
    }
    let current = '';
    for (const piece of unit.text.split(/(?<=\n)|(?<=[.!?。])\s+/)) {
      if (current && current.length + piece.length > CHUNK_CHARS) {
        chunks.push({ ordinal: chunks.length, locator: unit.locator, content: current.trim() });
        current = '';
      }
      current += piece.endsWith('\n') ? piece : `${piece} `;
    }
    if (current.trim()) chunks.push({ ordinal: chunks.length, locator: unit.locator, content: current.trim() });
  }
  return chunks;
}
