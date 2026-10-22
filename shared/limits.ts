// Every limit and constant lives here. Imported by both the browser bundle and the Netlify functions.

export const APP_NAME = 'Template Fill'; // working name: change it here (and in index.html's <title>)

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // per file; MAX_FILE_MB env var overrides on the server
export const CHUNK_BYTES = 3 * 1024 * 1024;      // Netlify functions take ~6 MB per request, so files travel in pieces
export const STALE_UPLOAD_MS = 60 * 60 * 1000;   // half-finished uploads are removed after an hour
export const UPLOAD_RETRIES = 3;
export const MAX_STR = 200;
export const MAX_NOTE = 4000;

// Filling a template from documents (see netlify/functions/fill.ts)
export const MAX_FILL_FIELDS = 600;            // blanks sent to the AI in one run
export const MAX_FILL_DOCS = 30;               // documents in one run
export const MAX_FILL_DOC_CHARS = 600_000;     // all documents together, in characters (about 150,000 tokens)
export const MAX_SCAN_BYTES = 2.6 * 1024 * 1024; // scanned PDFs sent to the AI as PDFs, all together (the request must stay under Netlify's ~6 MB)
export const MAX_DOC_PAGES_TEXT = 400;         // spreadsheet rows read per sheet when a document is turned into text
export const RUN_STALE_MS = 20 * 60 * 1000;    // a run still going after 20 minutes is marked failed
export const RUN_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // finished runs are deleted after a week
export const RUN_POLL_MS = 3000;
export const RUN_GIVE_UP_MS = 15 * 60 * 1000;  // the browser stops waiting after 15 minutes

/**
 * The file types the app accepts, by extension. `magic` is how the file's first bytes must start, so a renamed file
 * is caught: PDFs start "%PDF-", Word/Excel files (.docx/.xlsx) are ZIP containers ("PK"), old Office files (.xls/.doc)
 * are OLE containers. Text types (CSV, TXT) have no signature.
 */
export const FILE_TYPES = {
  pdf:  { label: 'PDF',              magic: [0x25, 0x50, 0x44, 0x46, 0x2d], template: true,  source: true },
  docx: { label: 'Word document',    magic: [0x50, 0x4b],                   template: true,  source: true },
  xlsx: { label: 'Excel workbook',   magic: [0x50, 0x4b],                   template: true,  source: true },
  xls:  { label: 'Excel 97-2003',    magic: [0xd0, 0xcf, 0x11, 0xe0],       template: false, source: true },
  doc:  { label: 'Word 97-2003',     magic: [0xd0, 0xcf, 0x11, 0xe0],       template: false, source: true },
  csv:  { label: 'CSV',              magic: null,                           template: false, source: true },
  txt:  { label: 'Text',             magic: null,                           template: false, source: true },
  png:  { label: 'PNG image',        magic: [0x89, 0x50, 0x4e, 0x47],       template: false, source: true },
  jpg:  { label: 'JPEG image',       magic: [0xff, 0xd8, 0xff],             template: false, source: true },
} as const;
export type FileType = keyof typeof FILE_TYPES;

/** The type of a file from its name ("Bid Form.XLSX" -> "xlsx"; "photo.jpeg" -> "jpg"), or null when not accepted. */
export function fileTypeOf(name: string): FileType | null {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '').replace(/^jpeg$/, 'jpg');
  return ext in FILE_TYPES ? (ext as FileType) : null;
}

/** Do these first bytes match what a file of this type must start with? */
export function magicMatches(type: FileType, head: Uint8Array): boolean {
  const m = FILE_TYPES[type].magic;
  if (!m) return true;
  return m.every((b, i) => head[i] === b);
}

export const acceptList = (use: 'template' | 'source') =>
  (Object.keys(FILE_TYPES) as FileType[]).filter((t) => FILE_TYPES[t][use]).map((t) => `.${t}${t === 'jpg' ? ',.jpeg' : ''}`).join(',');

export const limitMessages = {
  tooBig: (bytes: number, max = MAX_FILE_BYTES) =>
    `This file is ${Math.round(bytes / 1048576)} MB. Files can be up to ${Math.round(max / 1048576)} MB.`,
  badType: (use: 'template' | 'source') =>
    use === 'template'
      ? 'Templates can be Word (.docx), Excel (.xlsx) or PDF files.'
      : 'Documents can be PDF, Word, Excel, CSV, text, PNG or JPEG files.',
  notWhatItSays: (label: string) => `This file is named like a ${label} but its contents are not. Export it again and re-upload.`,
} as const;
