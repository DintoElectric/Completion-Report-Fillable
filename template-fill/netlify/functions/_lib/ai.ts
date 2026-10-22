// Asking Claude to read a job's documents and propose values for the template's blanks.
// The key (ANTHROPIC_API_KEY) lives only in Netlify's environment and is used only here, on the server.
import type { AiFieldRequest, AiProposal, FillRequest } from '../../../shared/types.ts';
import { excelSerial, parseNumberInput } from '../../../shared/closeout.ts';
import { HttpError } from './http.ts';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';   // override with the ANTHROPIC_MODEL environment variable
export const aiModel = () => process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;

export const SYSTEM_PROMPT = `You help project managers at an electrical contractor fill in a job closeout spreadsheet from the job's documents.

The documents may include: a change order (CO) log, a job profit / billing report ("M25"), notes from the foreman or project manager, purchase order lists, and summaries of the cost-accounting report ("JBI"). Each document is text taken from a file. PDF text keeps the page's horizontal layout, so use the column headings' positions to tell which column an amount sits under.

Rules:
1. Use only what the documents say. If a blank cannot be found or worked out from them, leave it out of your answer. A blank left empty is correct; an invented number is not.
2. Numbers are plain numbers: no $ sign, no thousands commas, a minus sign for negatives, up to two decimals. Dates are YYYY-MM-DD.
3. When you add numbers up yourself (for example several change orders), say which ones in "note" and give "medium" confidence.
4. "source" names the document and where in it (page, change order number, line), in under 160 characters. Never write a source you did not actually read.
5. Confidence: "high" = stated plainly in a document; "medium" = you added up numbers or chose between readings; "low" = a guess the person must check.
6. Change orders marked rejected, void, expired or not approved do not count as approved. "Completed" and "proceeding" change orders are work that is done or underway but not yet approved.
7. Free-text rows (notes, lessons learned, comments) must paraphrase or quote what the documents or notes actually say, one idea per row, under 220 characters. Do not write advice or opinions of your own. Where the template's printed labels (for example "WHAT WENT WELL:") show which section a row belongs to, put matching content there.
8. If a blank offers choices, your value must be exactly one of them.
9. Answer only by calling submit_fields, and include only the blanks you can fill.`;

export const TOOL = {
  name: 'submit_fields',
  description: 'Submit the values found for the blanks. Include only blanks that the documents support.',
  input_schema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The blank\'s id, exactly as listed.' },
            value: { type: ['string', 'number'], description: 'The value to put in the blank.' },
            source: { type: 'string', description: 'Document name and where in it.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            note: { type: 'string', description: 'How you got it, or what to double-check. Optional.' },
          },
          required: ['id', 'value', 'source', 'confidence'],
        },
      },
    },
    required: ['fields'],
  },
} as const;

const line = (f: AiFieldRequest) => {
  const extra = [f.hint, f.choices?.length ? `Choices: ${f.choices.join('; ')}` : ''].filter(Boolean).join(' ');
  return `${f.id} | ${f.group} | ${f.label} | ${f.kind}${extra ? ` | ${extra}` : ''}`;
};

export function buildUserMessage(req: FillRequest): string {
  const parts: string[] = [];
  if (req.digest) parts.push(`<jbi_summary>\n${req.digest}\n</jbi_summary>`);
  parts.push('<documents>\n' + req.documents.map((d) => `<document name="${d.name.replace(/"/g, "'")}">\n${d.text}\n</document>`).join('\n') + '\n</documents>');
  if (req.note_context?.length) parts.push(`<template_notes_rows>\nPrinted rows of the template's notes sections. Rows to fill are listed as blanks below.\n${req.note_context.join('\n')}\n</template_notes_rows>`);
  if (req.instructions) parts.push(`<extra_instructions_from_the_person>\n${req.instructions}\n</extra_instructions_from_the_person>`);
  parts.push(`<blanks>\nid | section | label | type | meaning\n${req.fields.map(line).join('\n')}\n</blanks>`);
  parts.push('Call submit_fields with the blanks you can fill from the documents.');
  return parts.join('\n\n');
}

/** The user turn: any scanned PDFs as PDF documents first, then the text. */
export function buildContent(req: FillRequest) {
  const blocks: unknown[] = (req.attachments ?? []).map((a) => ({ type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: a.data } }));
  blocks.push({ type: 'text', text: buildUserMessage(req) + ((req.attachments?.length) ? `\n\nScanned PDFs attached above, in order: ${req.attachments.map((a) => a.name).join('; ')}.` : '') });
  return blocks;
}

/** Checks the AI's answer against the blanks that were asked about. Anything that does not fit is dropped, never guessed at. */
export function parseProposals(input: unknown, fields: AiFieldRequest[]): { proposals: AiProposal[]; dropped: number } {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const list = (input as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(list)) throw new HttpError(502, 'The AI answered in a form the app could not read. Try again.');
  const out: AiProposal[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of list) {
    const r = raw as Record<string, unknown> | null;
    const f = r && typeof r.id === 'string' ? byId.get(r.id) : undefined;
    if (!r || !f || seen.has(f.id)) { dropped++; continue; }
    let value: string | number | null = null;
    if (f.kind === 'number') {
      value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : typeof r.value === 'string' ? parseNumberInput(r.value) : null;
    } else if (f.kind === 'date') {
      value = typeof r.value === 'string' && excelSerial(r.value) !== null ? r.value.trim().slice(0, 10) : null;
    } else if (typeof r.value === 'string') {
      const t = r.value.replace(/\s+/g, ' ').trim().slice(0, 600);
      value = f.choices?.length ? (f.choices.find((c) => c.toLowerCase() === t.toLowerCase()) ?? null) : t || null;
    }
    if (value === null || value === '') { dropped++; continue; }
    seen.add(f.id);
    const conf = r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low' ? r.confidence : 'low';
    out.push({
      id: f.id, value,
      source: typeof r.source === 'string' ? r.source.slice(0, 200) : '',
      confidence: conf,
      note: typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, 300) : undefined,
    });
  }
  return { proposals: out, dropped };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function askClaude(req: FillRequest, fetchImpl: typeof fetch = fetch): Promise<AiProposal[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new HttpError(503, 'The AI is not set up yet. An admin needs to add ANTHROPIC_API_KEY in Netlify.');
  const body = JSON.stringify({
    model: aiModel(),
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: buildContent(req) }],
  });
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12 * 60 * 1000);
    try {
      res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body,
        signal: ctl.signal,
      });
    } catch (e) {
      console.error('AI request failed', e);
      if (attempt === 2) throw new HttpError(504, 'The AI did not answer in time. Try again, or use fewer documents.');
      await wait(3000 * (attempt + 1));
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      console.error('AI busy or failing', res.status);
      if (attempt === 2) throw new HttpError(503, 'The AI service is busy right now. Try again in a few minutes.');
      await wait(4000 * (attempt + 1));
      continue;
    }
    break;
  }
  if (!res) throw new HttpError(503, 'The AI service could not be reached. Try again.');
  if (res.status === 401 || res.status === 403) throw new HttpError(503, "The AI key was not accepted. An admin needs to check ANTHROPIC_API_KEY in Netlify.");
  if (res.status === 404) throw new HttpError(503, `The AI model "${aiModel()}" was not found. An admin can set ANTHROPIC_MODEL in Netlify.`);
  if (res.status === 400 || res.status === 413) {
    console.error('AI rejected the request', res.status, (await res.text()).slice(0, 400));
    throw new HttpError(400, 'The AI would not take this much text. Remove some documents and try again.');
  }
  if (!res.ok) { console.error('AI error', res.status); throw new HttpError(502, 'The AI returned an error. Try again.'); }
  const data = (await res.json()) as { stop_reason?: string; content?: { type: string; name?: string; input?: unknown }[] };
  if (data.stop_reason === 'max_tokens') throw new HttpError(502, 'The AI ran out of room while answering. Try again with fewer documents.');
  const use = data.content?.find((b) => b.type === 'tool_use' && b.name === TOOL.name);
  if (!use) throw new HttpError(502, 'The AI did not give an answer the app could use. Try again.');
  const { proposals, dropped } = parseProposals(use.input, req.fields);
  if (dropped) console.warn(`AI answer: ${dropped} entries dropped as not matching the blanks`);
  return proposals;
}
