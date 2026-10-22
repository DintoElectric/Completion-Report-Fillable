// Writes values into a workbook by editing the sheet's XML directly instead of loading and re-saving it through a spreadsheet
// library. A library round-trip drops things the closeout template relies on: the PM / foreman dropdowns (a newer Excel
// extension), the logo and the page setup. Here only the cells named are touched, and a cell that holds a formula is refused.
import PizZip from 'pizzip';
import { colNum, splitAddr } from '../../shared/closeout.ts';

export interface WriteResult {
  bytes: Uint8Array;
  written: string[];
  skipped: { cell: string; reason: string }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The path inside the zip of the sheet with this name. */
export function sheetPath(zip: PizZip, sheetName: string): string {
  const wb = zip.file('xl/workbook.xml')?.asText();
  const rels = zip.file('xl/_rels/workbook.xml.rels')?.asText();
  if (!wb || !rels) throw new Error('This is not an Excel workbook.');
  let rid: string | undefined;
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    if (unesc(attr(m[0], 'name') ?? '') === sheetName) { rid = attr(m[0], 'r:id'); break; }
  }
  if (!rid) throw new Error(`The template has no sheet named "${sheetName}".`);
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attr(m[0], 'Id') === rid) {
      const target = attr(m[0], 'Target') ?? '';
      return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    }
  }
  throw new Error('The template\'s sheet could not be located.');
}

function cellXml(addr: string, style: string | undefined, value: number | string): string {
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number') return `<c r="${addr}"${s}><v>${Number.isInteger(value) ? value : String(value)}</v></c>`;
  return `<c r="${addr}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/** Sets one cell in the sheet XML. Returns the new XML, or a reason it was not written. */
function setCell(xml: string, addr: string, value: number | string): { xml: string } | { reason: string } {
  const { row, col } = splitAddr(addr);
  const rowRe = new RegExp(`<row\\b[^>]*?\\sr="${row}"[^>]*?(/>|>)`);
  const rm = rowRe.exec(xml);
  if (!rm) {
    // no such row yet: add it in order
    const newRow = `<row r="${row}">${cellXml(addr, undefined, value)}</row>`;
    for (const m of xml.matchAll(/<row\b[^>]*?\sr="(\d+)"/g)) {
      if (Number(m[1]) > row) return { xml: xml.slice(0, m.index) + newRow + xml.slice(m.index) };
    }
    const end = xml.indexOf('</sheetData>');
    if (end < 0) return { reason: 'The sheet has no data section.' };
    return { xml: xml.slice(0, end) + newRow + xml.slice(end) };
  }
  let start = rm.index;
  let bodyStart: number, bodyEnd: number, openTag = rm[0];
  if (rm[1] === '/>') {
    // an empty row written as <row .../>: open it up
    const opened = openTag.replace(/\/>$/, '>');
    xml = xml.slice(0, start) + opened + '</row>' + xml.slice(start + openTag.length);
    openTag = opened;
  }
  bodyStart = start + openTag.length;
  bodyEnd = xml.indexOf('</row>', bodyStart);
  const body = xml.slice(bodyStart, bodyEnd);

  const cellRe = new RegExp(`<c\\b[^>]*?\\sr="${addr}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  const cm = cellRe.exec(body);
  if (cm) {
    if (/<f[\s>/]/.test(cm[0])) return { reason: 'The template has a formula in this cell, so it was left alone.' };
    const style = attr(/<c\b[^>]*>/.exec(cm[0])![0], 's');
    const nb = body.slice(0, cm.index) + cellXml(addr, style, value) + body.slice(cm.index + cm[0].length);
    return { xml: xml.slice(0, bodyStart) + nb + xml.slice(bodyEnd) };
  }
  // no such cell in the row: insert it in column order
  let at = body.length;
  for (const m of body.matchAll(/<c\b[^>]*?\sr="([A-Z]+)\d+"/g)) {
    if (colNum(m[1]) > col) { at = m.index!; break; }
  }
  const nb = body.slice(0, at) + cellXml(addr, undefined, value) + body.slice(at);
  return { xml: xml.slice(0, bodyStart) + nb + xml.slice(bodyEnd) };
}

/** Removes the stored result from formula cells, so a quick-look preview shows blanks instead of stale numbers. Excel recalculates on open. */
function dropCachedResults(xml: string): string {
  return xml.replace(/<c\b([^>]*)>(<f\b[^>]*?\/>|<f\b[^>]*>[\s\S]*?<\/f>)<v>[\s\S]*?<\/v><\/c>/g, (_m, attrs: string, f: string) => `<c${attrs.replace(/\st="(?:str|e|b)"/, '')}>${f}</c>`);
}

function forceRecalc(wb: string): string {
  if (/<calcPr\b/.test(wb)) {
    return wb.replace(/<calcPr\b([^>]*?)(\/?)>/, (_m, a: string, close: string) => (/fullCalcOnLoad=/.test(a) ? `<calcPr${a}${close}>` : `<calcPr${a} fullCalcOnLoad="1"${close}>`));
  }
  const tag = '<calcPr fullCalcOnLoad="1"/>';
  return wb.includes('<extLst') ? wb.replace('<extLst', `${tag}<extLst`) : wb.replace('</workbook>', `${tag}</workbook>`);
}

export function fillWorkbook(template: Uint8Array | ArrayBuffer, sheetName: string, values: Record<string, number | string>): WriteResult {
  const zip = new PizZip(template);
  const path = sheetPath(zip, sheetName);
  let xml = zip.file(path)?.asText();
  if (!xml) throw new Error('The template\'s sheet could not be read.');
  const written: string[] = [];
  const skipped: { cell: string; reason: string }[] = [];
  const ordered = Object.keys(values).sort((a, b) => { const A = splitAddr(a), B = splitAddr(b); return A.row - B.row || A.col - B.col; });
  for (const a of ordered) {
    const r = setCell(xml, a, values[a]);
    if ('reason' in r) skipped.push({ cell: a, reason: r.reason });
    else { xml = r.xml; written.push(a); }
  }
  zip.file(path, dropCachedResults(xml));
  const wb = zip.file('xl/workbook.xml')!.asText();
  zip.file('xl/workbook.xml', forceRecalc(wb));
  return { bytes: zip.generate({ type: 'uint8array', compression: 'DEFLATE' }), written, skipped };
}
