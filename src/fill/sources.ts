// Turns an uploaded document into something the filling can use. This runs in the browser, so a large file never has to fit in
// one request to a function, and only text (not the file) is sent to the AI.
import PizZip from 'pizzip';
import { parseJbi, type JbiData } from '../../shared/closeout.ts';
import { MAX_DOC_PAGES_TEXT, type FileType } from '../../shared/limits.ts';

export type Extracted =
  | { kind: 'jbi'; jbi: JbiData }
  | { kind: 'text'; text: string }
  | { kind: 'scan'; bytes: ArrayBuffer }          // a PDF with no text layer: the AI reads the PDF itself
  | { kind: 'skip'; reason: string };

/* ---------- PDF ---------- */
interface PdfTextItem { str?: string; transform?: number[] }
interface PdfPage { getTextContent(): Promise<{ items: PdfTextItem[] }> }
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage> }
export interface PdfjsLike { getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc> } }

const CHAR_PT = 4.5;          // how wide one text character is taken to be, to rebuild the page's columns
const MAX_LINE = 320;

/**
 * Text of a PDF that keeps its horizontal layout: each line's pieces are spaced out by where they sit on the page, so a table's
 * columns stay under their headings (like `pdftotext -layout`). Without that, an amount in a "Pending" column and one in an
 * "Approved" column read the same.
 */
export async function pdfToText(pdfjs: PdfjsLike, data: Uint8Array): Promise<{ text: string; pages: number }> {
  const doc = await pdfjs.getDocument({ data }).promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const pieces = items.filter((i) => i.str && i.str.trim() && i.transform).map((i) => ({ s: i.str as string, x: i.transform![4], y: i.transform![5] }));
    pieces.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: { y: number; items: { s: string; x: number }[] }[] = [];
    for (const it of pieces) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= 3) last.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    out.push(`--- page ${p} ---`);
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      let s = '';
      for (const it of l.items) {
        const want = Math.min(MAX_LINE, Math.round(it.x / CHAR_PT));
        if (s.length < want) s += ' '.repeat(want - s.length); else if (s && !s.endsWith(' ')) s += ' ';
        s += it.s;
      }
      out.push(s.trimEnd());
    }
  }
  return { text: out.join('\n'), pages: doc.numPages };
}

async function pdfText(bytes: ArrayBuffer): Promise<Extracted> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const { text, pages } = await pdfToText(pdfjs as unknown as PdfjsLike, new Uint8Array(bytes.slice(0)));
  const chars = text.replace(/--- page \d+ ---/g, '').replace(/\s+/g, '').length;
  if (chars < 40 * pages) return { kind: 'scan', bytes };
  return { kind: 'text', text };
}

/* ---------- Word ---------- */
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export function docxToText(bytes: ArrayBuffer | Uint8Array): string {
  const xml = new PizZip(bytes).file('word/document.xml')?.asText() ?? '';
  return decode(xml.replace(/<w:tab\s*\/>/g, '\t').replace(/<w:br\s*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- spreadsheets ---------- */
async function sheetText(bytes: ArrayBuffer, type: FileType): Promise<Extracted> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(new Uint8Array(bytes), { type: 'array', cellDates: true });
  const first = wb.Sheets[wb.SheetNames[0]];
  if (first && type !== 'csv') {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(first, { header: 1, raw: true, defval: '' });
    const jbi = parseJbi(rows);
    if (jbi) return { kind: 'jbi', jbi };
  }
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '' });
    const body = rows.filter((r) => r.some((c) => String(c).trim() !== '')).slice(0, MAX_DOC_PAGES_TEXT).map((r) => r.map((c) => String(c).trim()).join('\t'));
    if (body.length) parts.push(`## Sheet: ${name}\n${body.join('\n')}`);
  }
  if (!parts.length) return { kind: 'skip', reason: 'This spreadsheet has no data in it.' };
  return { kind: 'text', text: parts.join('\n\n') };
}

export async function extractSource(type: FileType, bytes: ArrayBuffer): Promise<Extracted> {
  try {
    switch (type) {
      case 'pdf': return await pdfText(bytes);
      case 'docx': {
        const text = docxToText(bytes);
        return text ? { kind: 'text', text } : { kind: 'skip', reason: 'No text was found in this Word document.' };
      }
      case 'xlsx': case 'xls': case 'csv': return await sheetText(bytes, type);
      case 'txt': { const text = new TextDecoder().decode(bytes).trim(); return text ? { kind: 'text', text } : { kind: 'skip', reason: 'This file is empty.' }; }
      case 'doc': return { kind: 'skip', reason: 'Old Word (.doc) files cannot be read. Save it as .docx and upload that.' };
      case 'png': case 'jpg': return { kind: 'skip', reason: 'Pictures cannot be read yet. If it holds text, upload it as a PDF or Word file.' };
    }
  } catch (e) {
    console.error('Reading a document failed', e);
    return { kind: 'skip', reason: 'This file could not be opened. It may be damaged or password-protected.' };
  }
}
