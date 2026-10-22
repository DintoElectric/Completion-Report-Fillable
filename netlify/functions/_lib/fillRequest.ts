// Checks a fill request from the browser before anything is stored or sent to the AI.
import type { AiFieldRequest, FillAttachment, FillRequest } from '../../../shared/types.ts';
import { HttpError } from './http.ts';
import { uuid } from './validate.ts';
import { MAX_FILL_DOC_CHARS, MAX_FILL_DOCS, MAX_FILL_FIELDS, MAX_NOTE, MAX_SCAN_BYTES } from './limits.ts';

const CELL = /^[A-Z]{1,3}[0-9]{1,5}$/;
const KINDS = ['number', 'text', 'date'] as const;
// control characters other than tab / newline are removed from every text
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

export function validateFillRequest(b: Record<string, unknown>): FillRequest {
  const allowed = ['job_id', 'fields', 'documents', 'attachments', 'digest', 'note_context', 'instructions'];
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new HttpError(400, `Unknown field "${k}".`);
  const job_id = uuid(b.job_id, 'job id');

  if (!Array.isArray(b.fields) || !b.fields.length) throw new HttpError(400, 'There are no blanks to fill.');
  if (b.fields.length > MAX_FILL_FIELDS) throw new HttpError(400, `That template has more than ${MAX_FILL_FIELDS} blanks for the AI to fill.`);
  const seen = new Set<string>();
  const fields: AiFieldRequest[] = b.fields.map((raw: unknown) => {
    const f = raw as Record<string, unknown>;
    if (!f || typeof f.id !== 'string' || !CELL.test(f.id) || seen.has(f.id)) throw new HttpError(400, 'One of the blanks is not valid.');
    seen.add(f.id);
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.length > 240) throw new HttpError(400, 'One of the blanks has no usable label.');
    if (!KINDS.includes(f.kind as (typeof KINDS)[number])) throw new HttpError(400, 'One of the blanks has an unknown type.');
    const choices = Array.isArray(f.choices) ? f.choices.filter((c): c is string => typeof c === 'string' && c.length <= 120).slice(0, 120).map(clean) : undefined;
    return {
      id: f.id,
      group: typeof f.group === 'string' ? clean(f.group).slice(0, 80) : '',
      label: clean(f.label).trim(),
      kind: f.kind as AiFieldRequest['kind'],
      key: typeof f.key === 'string' ? f.key.slice(0, 40) : '',
      hint: typeof f.hint === 'string' ? clean(f.hint).slice(0, 500) : undefined,
      choices: choices?.length ? choices : undefined,
    };
  });

  const docsIn = Array.isArray(b.documents) ? b.documents : [];
  const scansIn = Array.isArray(b.attachments) ? b.attachments : [];
  if (!docsIn.length && !scansIn.length) throw new HttpError(400, 'Add at least one document the AI can read.');
  if (docsIn.length + scansIn.length > MAX_FILL_DOCS) throw new HttpError(400, `Use at most ${MAX_FILL_DOCS} documents at a time.`);
  let chars = 0;
  const documents = docsIn.map((raw: unknown) => {
    const d = raw as Record<string, unknown>;
    if (!d || typeof d.name !== 'string' || !d.name.trim() || typeof d.text !== 'string') throw new HttpError(400, 'One of the documents is not valid.');
    const text = clean(d.text);
    chars += text.length;
    return { name: clean(d.name).trim().slice(0, 255), text };
  });
  if (chars > MAX_FILL_DOC_CHARS) throw new HttpError(413, `These documents hold ${Math.round(chars / 1000)},000 characters of text; the limit is ${Math.round(MAX_FILL_DOC_CHARS / 1000)},000. Remove some documents.`);

  let b64 = 0;
  const attachments: FillAttachment[] = scansIn.map((raw: unknown) => {
    const d = raw as Record<string, unknown>;
    if (!d || typeof d.name !== 'string' || !d.name.trim() || typeof d.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(d.data)) throw new HttpError(400, 'One of the scanned documents is not valid.');
    b64 += d.data.length;
    return { name: clean(d.name).trim().slice(0, 255), data: d.data };
  });
  if (b64 > Math.ceil((MAX_SCAN_BYTES * 4) / 3) + 8) throw new HttpError(413, `The scanned PDFs together are too big for the AI (the limit is ${(MAX_SCAN_BYTES / 1048576).toFixed(1)} MB). Remove one or send fewer pages.`);

  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? clean(v).slice(0, max) : undefined);
  const note_context = Array.isArray(b.note_context) ? b.note_context.filter((s): s is string => typeof s === 'string').slice(0, 200).map((s) => clean(s).slice(0, 300)) : undefined;
  return { job_id, fields, documents, attachments: attachments.length ? attachments : undefined, digest: text(b.digest, 12000), note_context, instructions: text(b.instructions, MAX_NOTE) };
}
