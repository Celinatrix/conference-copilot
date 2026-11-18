import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/kb/parse.js';

const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const slide = (t: string) => `<p:sld ${ns}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const notes = (t: string) => `<p:notes ${ns}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;

/** A deck whose slides were reordered after creation: file names no longer match what the presenter sees. */
async function reorderedDeck() {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', slide('Pricing method'));
  zip.file('ppt/slides/slide2.xml', slide('Executive summary'));
  zip.file('ppt/slides/slide3.xml', slide('Reinsurance with Gen Re'));
  // Presentation order: slide2, slide1, slide3.
  zip.file('ppt/presentation.xml', `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId7"/><p:sldId id="257" r:id="rId5"/><p:sldId id="258" r:id="rId9"/></p:sldIdLst></p:presentation>`);
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships><Relationship Id="rId5" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId7" Type="${REL}/slide" Target="slides/slide2.xml"/><Relationship Id="rId9" Type="${REL}/slide" Target="/ppt/slides/slide3.xml"/><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>`,
  );
  // Notes are linked per slide, not by number: slide3's notes live in notesSlide1. Like real decks, every slide
  // has a relationships part (here slide1/slide2 link only to their layout).
  for (const n of [1, 2]) {
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, `<Relationships><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`);
  }
  zip.file('ppt/slides/_rels/slide3.xml.rels', `<Relationships><Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`);
  zip.file('ppt/notesSlides/notesSlide1.xml', notes('Explain the 60% quota share'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('PPTX slide order', () => {
  it('numbers slides in presentation order and attaches notes through the slide relationship', async () => {
    const doc = await parseDocument(await reorderedDeck(), 'deck.pptx');
    expect(doc.units.map((u) => [u.locator, u.text.split('\n')[0]])).toEqual([
      ['slide 1', 'Executive summary'],
      ['slide 2', 'Pricing method'],
      ['slide 3', 'Reinsurance with Gen Re'],
    ]);
    expect(doc.units[2].text).toContain('Explain the 60% quota share');
    // slide1.xml has no notes relationship, so it must not pick up notesSlide1 by number.
    expect(doc.units[1].text).not.toContain('quota share');
  });
});
