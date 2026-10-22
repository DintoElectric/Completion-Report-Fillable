// Reads a template workbook into the plain grid that shared/closeout.ts works on, and finds the lists behind its dropdowns
// (the PM and foreman cells take their choices from another sheet).
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import { addr, colNum, colLetter, type CellVal, type GridCell, type SheetGrid } from '../../shared/closeout.ts';
import { sheetPath } from './writeXlsx.ts';

export interface TemplateInfo {
  grid: SheetGrid;
  choices: Record<string, string[]>;   // cell address -> allowed values
}

function plain(v: ExcelJS.CellValue): { v: CellVal; f?: string } {
  if (v === null || v === undefined) return { v: null };
  if (typeof v === 'string' || typeof v === 'number') return { v };
  if (typeof v === 'boolean') return { v: v ? 'TRUE' : 'FALSE' };
  if (v instanceof Date) return { v: v.toISOString().slice(0, 10) };
  const o = v as unknown as Record<string, unknown>;
  if ('formula' in o || 'sharedFormula' in o) {
    const f = String(o.formula ?? o.sharedFormula ?? '');
    const r = o.result;
    return { v: typeof r === 'string' || typeof r === 'number' ? r : null, f: f || '=' };
  }
  if (Array.isArray(o.richText)) return { v: (o.richText as { text: string }[]).map((t) => t.text).join('') };
  if ('text' in o) return { v: String(o.text) };
  if ('error' in o) return { v: String(o.error) };
  return { v: null };
}

function rangeValues(wb: ExcelJS.Workbook, ref: string, homeSheet: string): string[] {
  const lit = /^"(.*)"$/.exec(ref.trim());
  if (lit) return lit[1].split(',').map((s) => s.trim()).filter(Boolean);
  const m = /^(?:'?([^'!]+)'?!)?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(ref.trim());
  if (!m) return [];
  const ws = wb.getWorksheet(m[1] ?? homeSheet);
  if (!ws) return [];
  const c1 = colNum(m[2]), r1 = Number(m[3]), c2 = m[4] ? colNum(m[4]) : c1, r2 = m[5] ? Number(m[5]) : r1;
  const out: string[] = [];
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
    const t = plain(ws.getCell(r, c).value).v;
    if (t !== null && String(t).trim()) out.push(String(t).trim());
  }
  return out;
}

/** Dropdown lists on the sheet: both the classic <dataValidation> and the newer x14 form Excel uses for lists on another sheet. */
function dropdownRefs(xml: string): { cells: string[]; ref: string }[] {
  const out: { cells: string[]; ref: string }[] = [];
  const cellsOf = (sqref: string) => sqref.split(/\s+/).flatMap((part) => {
    const [a, b] = part.split(':');
    if (!b) return [a];
    const A = /^([A-Z]+)(\d+)$/.exec(a), B = /^([A-Z]+)(\d+)$/.exec(b);
    if (!A || !B) return [a];
    const list: string[] = [];
    for (let r = Number(A[2]); r <= Number(B[2]); r++) for (let c = colNum(A[1]); c <= colNum(B[1]); c++) list.push(`${colLetter(c)}${r}`);
    return list;
  });
  for (const m of xml.matchAll(/<x14:dataValidation\b[^>]*type="list"[^>]*>[\s\S]*?<xm:f>([^<]*)<\/xm:f>[\s\S]*?<xm:sqref>([^<]*)<\/xm:sqref>/g)) {
    out.push({ ref: m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'), cells: cellsOf(m[2]) });
  }
  for (const m of xml.matchAll(/<dataValidation\b([^>]*)>[\s\S]*?<formula1>([^<]*)<\/formula1>/g)) {
    if (!/type="list"/.test(m[1])) continue;
    const sq = /sqref="([^"]*)"/.exec(m[1])?.[1];
    if (sq) out.push({ ref: m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&'), cells: cellsOf(sq) });
  }
  return out;
}

export async function readTemplate(bytes: Uint8Array | ArrayBuffer): Promise<TemplateInfo> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as ArrayBuffer);
  const ws = wb.worksheets.find((w) => /close\s*-?\s*out/i.test(w.name)) ?? wb.worksheets[0];
  if (!ws) throw new Error('This workbook has no sheets.');
  const merges = ((ws.model as unknown as { merges?: string[] }).merges ?? []).slice();
  // ExcelJS repeats a merged area's value in every cell of the area; only the top-left cell really holds it.
  const slaves = new Set<string>();
  for (const m of merges) {
    const [s, e] = m.split(':');
    if (!e) continue;
    const S = /^([A-Z]+)(\d+)$/.exec(s), E = /^([A-Z]+)(\d+)$/.exec(e);
    if (!S || !E) continue;
    for (let r = Number(S[2]); r <= Number(E[2]); r++) for (let c = colNum(S[1]); c <= colNum(E[1]); c++) if (addr(c, r) !== s) slaves.add(addr(c, r));
  }
  const cells: Record<string, GridCell> = {};
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (slaves.has(addr(c, r))) return;
      const p = plain(cell.value);
      if (p.v === null && !p.f) return;
      cells[addr(c, r)] = p.f ? { v: p.v, f: p.f } : { v: p.v };
    });
  });
  const grid: SheetGrid = { name: ws.name, cells, merges, maxRow: ws.rowCount, maxCol: Math.max(ws.columnCount, 14) };

  const choices: Record<string, string[]> = {};
  try {
    const zip = new PizZip(bytes);
    const xml = zip.file(sheetPath(zip, ws.name))?.asText() ?? '';
    for (const d of dropdownRefs(xml)) {
      const list = rangeValues(wb, d.ref, ws.name);
      if (list.length) for (const c of d.cells) choices[c] = list;
    }
  } catch {
    /* no dropdown information: the fields simply have no choices */
  }
  return { grid, choices };
}
