import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkUnits, detectKind, parseDocument } from '../src/kb/parse.js';
import { searchTerms, selectContext } from '../src/kb/retrieve.js';
import { migrate, openPglite, type Db } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { makeDocx, makePdf, makePptx, makeXlsx } from './fixtures.js';

describe('document parsing', () => {
  it('detects supported kinds only', () => {
    expect(detectKind('Report.PDF')).toBe('pdf');
    expect(detectKind('deck.pptx')).toBe('pptx');
    expect(detectKind('photo.png')).toBeNull();
  });

  it('reads PDF text page by page', async () => {
    const doc = await parseDocument(await makePdf(['Loss ratio was 62 percent in 2025.', 'Combined ratio improved to 94 percent.']), 'r.pdf');
    expect(doc.unitCount).toBe(2);
    expect(doc.units.map((u) => u.locator)).toEqual(['trang 1', 'trang 2']);
    expect(doc.units[1].text).toContain('Combined ratio');
    expect(doc.warning).toBeNull();
  });

  it('warns when a PDF has no extractable text', async () => {
    const doc = await parseDocument(await makePdf(['', '']), 'scan.pdf');
    expect(doc.units).toHaveLength(0);
    expect(doc.warning).toMatch(/scan/);
  });

  it('reads DOCX into numbered sections', async () => {
    const doc = await parseDocument(await makeDocx(['Dự phòng IBNR được tính bằng chain ladder.', 'Giả định lạm phát 4%.']), 'm.docx');
    expect(doc.units[0].locator).toBe('phần 1');
    expect(doc.units[0].text).toContain('chain ladder');
    expect(doc.units[0].text).toContain('lạm phát 4%');
  });

  it('reads PPTX slides with speaker notes', async () => {
    const doc = await parseDocument(await makePptx([['Agenda', 'Reserving update'], ['Results', 'Loss ratio 62%']], { 2: 'Mention the hail events' }), 'd.pptx');
    expect(doc.units.map((u) => u.locator)).toEqual(['slide 1', 'slide 2']);
    expect(doc.units[1].text).toContain('Loss ratio 62%');
    expect(doc.units[1].text).toContain('Mention the hail events');
  });

  it('reads XLSX sheets with the header repeated per chunk', async () => {
    const rows: (string | number)[][] = [['Year', 'Premium', 'Claims']];
    for (let y = 2000; y < 2050; y++) rows.push([y, y * 10, y * 6]);
    const doc = await parseDocument(await makeXlsx({ Triangle: rows }), 't.xlsx');
    expect(doc.units.map((u) => u.locator)).toEqual(['sheet Triangle, dòng 2–41', 'sheet Triangle, dòng 42–51']);
    expect(doc.units[1].text.split('\n')[0]).toBe('Year | Premium | Claims');
  });

  it('reads CSV, including quoted commas and a BOM', async () => {
    const doc = await parseDocument(Buffer.from('﻿line,amount\n"Motor, retail",1200\nProperty,800\n'), 'x.csv');
    expect(doc.units[0].text).toBe('line | amount\nMotor, retail | 1200\nProperty | 800');
  });

  it('splits long units into bounded chunks that keep their locator', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about reserving.`).join(' ');
    const chunks = chunkUnits([{ locator: 'trang 7', text: long }]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.locator === 'trang 7' && c.content.length <= 1600)).toBe(true);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });
});

describe('retrieval', () => {
  let db: Db;
  let conferenceId: string;

  beforeAll(async () => {
    db = await openPglite(null);
    await migrate(db, loadConfig().migrationsDir);
    const [u] = await db.query<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ('kb@x.test', 'KB', 'x') RETURNING id`);
    const [w] = await db.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('w') RETURNING id`);
    const [c] = await db.query<{ id: string }>(`INSERT INTO conferences (workspace_id, created_by, name) VALUES ($1, $2, 'c') RETURNING id`, [w.id, u.id]);
    conferenceId = c.id;
    const [d] = await db.query<{ id: string }>(
      `INSERT INTO documents (conference_id, uploaded_by, filename, kind, size_bytes, status) VALUES ($1, $2, 'notes.docx', 'docx', 1, 'ready') RETURNING id`,
      [c.id, u.id],
    );
    const texts = ['Dự phòng IBNR tăng 8% do bão.', 'Doanh thu phí bảo hiểm xe cơ giới tăng.', 'Chain ladder được dùng cho tam giác bồi thường.'];
    for (const [i, t] of texts.entries()) {
      await db.query(`INSERT INTO document_chunks (document_id, conference_id, ordinal, locator, content) VALUES ($1, $2, $3, $4, $5)`, [d.id, c.id, i, `phần ${i + 1}`, t]);
    }
  });
  afterAll(() => db.close());

  it('builds safe search terms from both languages', () => {
    expect(searchTerms(['What drove the IBNR increase?', 'Điều gì làm dự phòng IBNR tăng?'])).toEqual(['drove', 'ibnr', 'increase', 'điều', 'làm', 'dự', 'phòng', 'tăng']);
  });

  it('sends a small knowledge base whole', async () => {
    const r = await selectContext(db, conferenceId, ['anything']);
    expect(r.mode).toBe('all');
    expect(r.chunks).toHaveLength(3);
    expect(r.chunks[0]).toMatchObject({ filename: 'notes.docx', locator: 'phần 1' });
  });

  it('ranks by keyword when the knowledge base exceeds the budget', async () => {
    const r = await selectContext(db, conferenceId, ['chain ladder method'], 60);
    expect(r.mode).toBe('ranked');
    expect(r.chunks.map((c) => c.locator)).toEqual(['phần 3']);
  });

  it('reports no match instead of guessing', async () => {
    expect((await selectContext(db, conferenceId, ['quantum computing'], 60)).mode).toBe('none');
  });
});
