import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/** Builds small but valid Office/PDF files in memory so parser tests need no binary fixtures. */

export async function makePdf(pages: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = pdf.addPage([595, 842]);
    page.drawText(text, { x: 50, y: 780, size: 12, font });
  }
  return Buffer.from(await pdf.save());
}

export async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function makePptx(slides: string[][], notes: Record<number, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  const para = (t: string) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  slides.forEach((lines, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:txBody>${lines.map(para).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  });
  for (const [n, text] of Object.entries(notes)) {
    zip.file(`ppt/notesSlides/notesSlide${n}.xml`, `<p:notes ${ns}><p:cSld><p:spTree><p:sp><p:txBody>${para(text)}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function makeXlsx(sheets: Record<string, (string | number)[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
