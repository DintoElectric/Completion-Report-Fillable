// Tests for filling the closeout sheet. They build their own small template and JBI rows, so they need no real job files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import {
  addr, aggregateJbi, buildFields, checkTemplate, codesOfLabel, excelSerial, fieldListForProject, importProposals, jbiDigest, matchPoLines, noteContext, parseImportText, parseJbi, parseNumberInput, parsePoLog, poProposals, poRowsOf,
  ruleProposals, splitAddr, toCellValues, type Field,
} from '../shared/closeout.ts';
import { readTemplate } from '../src/fill/template.ts';
import { fillWorkbook } from '../src/fill/writeXlsx.ts';
import { docxToText, pdfToText, type PdfjsLike } from '../src/fill/sources.ts';
import { askClaude, buildContent, buildUserMessage, parseProposals } from '../netlify/functions/_lib/ai.ts';
import { validateFillRequest } from '../netlify/functions/_lib/fillRequest.ts';
import { HttpError } from '../netlify/functions/_lib/http.ts';
import type { FillRequest } from '../shared/types.ts';

/* ---------- a small closeout template, built the way the real one is laid out ---------- */
async function makeTemplate(o: { a3?: string | null; a4?: string; meetLabel?: string } = {}): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const lists = wb.addWorksheet('Sheet1');
  ['ANN PM', 'BOB PM', 'CY PM'].forEach((n, i) => { lists.getCell(i + 1, 1).value = n; });
  ['DAN FOREMAN', 'EVE FOREMAN'].forEach((n, i) => { lists.getCell(i + 1, 2).value = n; });
  const ws = wb.addWorksheet('50% CLOSE OUT ');
  const put = (a: string, v: ExcelJS.CellValue, numFmt?: string) => { const c = ws.getCell(a); c.value = v; if (numFmt) c.numFmt = numFmt; };
  put('A3', o.a3 === undefined ? 'JOB NAME & #' : o.a3); put('A4', o.a4 ?? '50% MEETING');
  ws.getCell('A4').dataValidation = { type: 'list', formulae: ['"50% MEETING,CLOSEOUT MEETING"'] };
  put('A6', 'PM:'); put('C6', 'DATE:'); ws.mergeCells('C6:G6'); put('A7', 'FOREMAN:');
  ws.getCell('B6').dataValidation = { type: 'list', formulae: ['Sheet1!$A$1:$A$3'] };
  ws.getCell('B7').dataValidation = { type: 'list', formulae: ['Sheet1!$B$1:$B$2'] };
  ws.getCell('H6').numFmt = 'm/d/yyyy';
  put('C10', 'CONTRACT'); put('D10', 'PROFIT (M25)');
  put('A11', 'ORIGINAL CONTRACT:'); ws.mergeCells('A11:B11'); ws.getCell('C11').numFmt = '$#,##0.00'; ws.getCell('D11').numFmt = '$#,##0.00';
  put('A12', 'BUY OUT:'); put('C12', { formula: 'C11', result: 0 }); put('D12', { formula: 'D45', result: 0 });
  put('A13', o.meetLabel ?? '50% MEETING:'); ws.getCell('C13').numFmt = '$#,##0.00'; ws.getCell('D13').numFmt = '$#,##0.00';
  put('A14', 'FINAL VALUE:');
  put('A16', 'LABOR');
  put('A18', 'HOURS ESTIMATED:'); ws.mergeCells('A18:B18'); ws.getCell('C18').numFmt = '#,##0.00';
  put('A19', 'CHANGE ORDERS: (COMPLETED & PROCEEDING) HOURS'); ws.mergeCells('A19:B19'); ws.getCell('C19').numFmt = '#,##0.00'; put('D19', 'MATERIALS'); ws.getCell('E19').numFmt = '$#,##0.00';
  put('A20', 'CHANGE ORDERS: (APPROVED)HOURS '); ws.mergeCells('A20:B20'); put('C20', null, '#,##0.00');
  put('B22', 'PRE-FAB USED:'); ws.getCell('C22').numFmt = '#,##0.00';
  put('A25', 'TOTAL HOURS USED:'); ws.mergeCells('A25:B25'); ws.getCell('C25').numFmt = '#,##0.00';
  put('A29', 'JOB AVERAGE RATE ESTIMATE:'); ws.mergeCells('A29:B29'); ws.getCell('C29').numFmt = '$#,##0.00';
  put('A30', 'JOB AVERAGE RATE ACTUAL:'); ws.mergeCells('A30:B30'); ws.getCell('C30').numFmt = '$#,##0.00';
  const head = ['LABOR COST CODES', 'ESTIMATE HOURS', 'CONSUMED HRS (JBI)', "BUDGET LESS APPROVED CO'S HRS", 'BUDGET PICK-UP/LOSS', 'ESTIMATE MATERIALS', 'CONSUMED MATERIALS (JBI)', 'BUDGET LESS APPROVED MATERIALS', 'BUDGET PICK-UP/LOSS', "APPROVED CO'S HRS", "APPROVED CO'S MATERIALS", '% HRS DIFF PER CODE #', '% MATERIAL DIFF PER CODE #', 'COMMENTS'];
  head.forEach((h, i) => { ws.getCell(35, i + 1).value = h; });
  ['008-TAX', '010-MISC OFFICE', '030-GEAR', '050,100,101,115-LIGHTING/CONTROLS', '3100-EXTERIOR LIGHTS'].forEach((l, i) => {
    const r = 36 + i;
    ws.getCell(r, 1).value = l;
    ws.getCell(r, 2).numFmt = '#,##0'; ws.getCell(r, 3).numFmt = '#,##0';
    ws.getCell(r, 4).value = { formula: `C${r}-J${r}`, result: 0 };
  });
  put('A41', 'TOTAL HOURS'); put('B41', { formula: 'SUM(B37:B40)', result: 0 }); put('F41', { formula: 'SUM(F36:F40)', result: 0 });
  put('A44', 'MATERIALS');
  ['PURCHASE ORDER', 'BUDGET COST', 'PO AMOUNT', 'BUDGET PICK-UP/LOSS', "APPROVED CO'S/OUT OF CONTRACT", "COMPLETED & PROCEEDING CO'S", 'COMMENTS'].forEach((h, i) => { ws.getCell(45, i + 1).value = h; });
  ['030-DISTRIBUTION', '110-FIRE ALARM', '300-TESTING'].forEach((l, i) => { const r = 46 + i; ws.getCell(r, 1).value = l; ws.getCell(r, 4).value = { formula: `B${r}-C${r}`, result: 0 }; });
  put('B49', { formula: 'SUM(B46:B48)', result: 0 });
  put('A52', "MAJOR PO'S  (FROM LIST ABOVE)  & FIELD INSTALLATION NOTES");
  put('A57', 'LESSONS LEARNED'); put('A58', 'WHAT WENT WELL:');
  ws.getCell('A53').numFmt = '@'; ws.getCell('A54').numFmt = '@'; ws.getCell('A59').numFmt = '@'; ws.getCell('A60').numFmt = '@';
  put('A61', 'Printed line that stays');
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/* ---------- JBI rows, shaped like the CF Data export ---------- */
const jbiRows = (): unknown[][] => [
  ['JBI   matts', '', '', 'Budget/Cost Report', '', '', '', ''],
  ['DATE 09/10/25', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', ''],
  ['', 'JOB #  REFERENCE', '', 'CUSTOMER', '', '', '', ''],
  ['', "38005  ST RAPHAEL'S CAMPUS", '', 'Gilbane', '', '', '', ''],
  ['', '', 'Budget', '', '', 'Budget', '', ''],
  ['Cat #', 'Description', 'Dollars', 'Cost', '% Doll', 'Hrs/Qty', 'Hrs/Qty', '% Hrs/Qty'],
  ['0008 O', 'TAXABLE ITEMS', 0, 6996, 0, 0, 0, 0],
  ['0010 O', 'MOBILIZATION', 736099, 611619, 83, 0, 0, 0],
  ['0030 L', 'SWITCHGEAR', 1000, 900, 0, 100, 90, 0],
  ['0030 B', 'SWITCHGEAR', 2000, 1800, 0, 0, 0, 0],
  ['0030 M', 'SWITCHGEAR', 500, 400, 0, 0, 0, 0],
  ['1030 M', 'SWITCHBOARDS', 4000, 3000, 0, 0, 0, 0],
  ['1030 L', 'SWITCHBOARDS', 3000, 1500, 0, 50, 40, 0],
  ['0100 L', 'EXTERIOR LIGHTS', 800, 400, 0, 10, 5, 0],
  ['1100 M', 'EXTERIOR POLES', 200, 150, 0, 0, 0, 0],
  ['9030 L', 'PREFAB', 0, 0, 0, 0, 12, 0],
  ['0700 L', 'NO SUCH CODE ON SHEET', 100, 100, 0, 7, 7, 0],
  [' ', '****CONTRACT TOTAL****', 100, 100, 0, 160, 154, 0],
  ['C/O 002', 'PDE CO#S 609, 612', ' ', ' ', ' ', ' ', ' ', ' '],
  ['0030 L', 'SWITCHGEAR', 600, 0, 0, 20, 0, 0],
  ['0030 M', 'SWITCHGEAR', 250, 100, 0, 0, 0, 0],
  [' ', '****C/O TOTAL****', 850, 100, 0, 20, 0, 0],
  [' ', '****FINAL TOTAL****', 200, 200, 0, 180, 166, 0],
];

/* ---------- addresses and numbers ---------- */
test('addresses, serial dates and typed numbers', () => {
  assert.equal(addr(27, 5), 'AA5');
  assert.deepEqual(splitAddr('AB12'), { col: 28, row: 12 });
  assert.equal(excelSerial('2025-09-10'), 45910);
  assert.equal(excelSerial('9/10/2025'), null);
  assert.equal(parseNumberInput('$1,234.50'), 1234.5);
  assert.equal(parseNumberInput('(88)'), -88);
  assert.equal(parseNumberInput('-12'), -12);
  assert.equal(parseNumberInput('abc'), null);
  assert.equal(parseNumberInput(''), null);
});

test('cost-code labels give their three-digit JBI codes', () => {
  assert.deepEqual(codesOfLabel('030-GEAR'), ['030']);
  assert.deepEqual(codesOfLabel('3100-EXTERIOR LIGHTS'), ['100']);
  assert.deepEqual(codesOfLabel('050,100,101,115-LIGHTING/CONTROLS'), ['050', '100', '101', '115']);
  assert.deepEqual(codesOfLabel('040-300 MEDIUM VOLTAGE'), ['040']);
  assert.equal(codesOfLabel('TOTAL HOURS'), null);
});

/* ---------- the template ---------- */
test('the template is read by its labels, formulas are never offered, dropdowns become choices', async () => {
  const t = await readTemplate(await makeTemplate());
  assert.equal(t.choices.B6?.join('|'), 'ANN PM|BOB PM|CY PM');
  assert.equal(t.choices.B7?.join('|'), 'DAN FOREMAN|EVE FOREMAN');
  assert.equal(t.choices.A4?.join('|'), '50% MEETING|CLOSEOUT MEETING');
  const fields = buildFields(t.grid, { choices: t.choices });
  const ids = new Set(fields.map((f) => f.id));
  for (const id of ['A3', 'A4', 'B6', 'B7', 'H6', 'C11', 'D11', 'C13', 'D13', 'C14', 'C18', 'C19', 'E19', 'C20', 'C22', 'C25', 'C29', 'C30']) assert.ok(ids.has(id), `missing ${id}`);
  assert.ok(!ids.has('C12') && !ids.has('D12'), 'formula cells are not fields');
  assert.ok(!ids.has('D36') && !ids.has('B41') && !ids.has('D46'), 'formula cells in tables are not fields');
  // labor table: six numbers and a comment per code row, found by their headings
  for (const col of ['B', 'C', 'F', 'G', 'J', 'K']) assert.ok(ids.has(`${col}38`), `${col}38`);
  assert.ok(ids.has('N38'));
  assert.equal(fields.find((f) => f.id === 'B38')?.codes?.join(), '030');
  assert.equal(fields.find((f) => f.id === 'B39')?.codes?.join(), '050,100,101,115');
  assert.equal(fields.find((f) => f.id === 'B40')?.codes?.join(), '100');
  // purchase orders: five blanks per row, and none for the formula column
  for (const col of ['B', 'C', 'E', 'F', 'G']) assert.ok(ids.has(`${col}46`), `${col}46`);
  assert.ok(!ids.has('D46'));
  // notes: empty rows are slots; printed rows are not
  assert.ok(ids.has('A53') && ids.has('A54') && ids.has('A59'));
  assert.ok(!ids.has('A61') || fields.find((f) => f.id === 'A61')?.group === 'Lessons learned');
  assert.equal(fields.find((f) => f.id === 'B6')?.choices?.length, 3);
  assert.equal(fields.find((f) => f.id === 'A3')?.current, undefined, 'the "JOB NAME & #" placeholder is not a value');
  assert.equal(fields.find((f) => f.id === 'A4')?.current, '50% MEETING');
  assert.ok(noteContext(t.grid).some((l) => l.includes('WHAT WENT WELL')));
});

test('a total row that stops short of the first or last row is flagged once per range', async () => {
  const t = await readTemplate(await makeTemplate());
  const w = checkTemplate(t.grid);
  assert.equal(w.length, 1);
  assert.match(w[0].text, /B41/);
  assert.match(w[0].text, /rows 37 to 40/);
  assert.match(w[0].text, /row 36 to row 40/);
});

/* ---------- JBI ---------- */
test('JBI rows are recognised, and other sheets are not', () => {
  assert.equal(parseJbi([['a', 'b'], [1, 2]]), null);
  const d = parseJbi(jbiRows())!;
  assert.equal(d.job, "38005 ST RAPHAEL'S CAMPUS");
  assert.equal(d.date, '09/10/25');
  assert.equal(d.lines.length, 13);
  assert.equal(d.coTotals.length, 1);
  assert.equal(d.contractTotal?.budHrs, 160);
  assert.deepEqual(d.warnings, []);
  assert.ok(parseJbi(jbiRows().filter((r) => !String(r[1]).includes('C/O TOTAL')))!.warnings.some((w) => /change-order sections/.test(w)));
});

test('the JBI rules: codes, labor vs material, contract vs change orders, pre-fab, rates', () => {
  const d = parseJbi(jbiRows())!;
  const a = aggregateJbi(d);
  // 030: estimate hrs from the contract section only; CO hrs from the CO section; consumed = every section
  // 1030 lines belong to code 030 too (the leading digit is a sub-category); burden (B) is neither hours nor material
  assert.deepEqual(a.byCode['030'], { estHrs: 100 + 50, consHrs: 90 + 40, estMat: 500 + 4000, consMat: 400 + 3000 + 100, coHrs: 20, coMat: 250 });
  assert.equal(a.byCode['100'].estMat, 200);
  assert.equal(a.byCode['008'].consMat, 6996);
  assert.equal(a.prefabHrs, 12);
  assert.equal(a.byCode['030'].consHrs, 130, 'pre-fab (9xxx) hours are kept out of the code');
  assert.equal(a.hoursEstimated, 160);
  assert.equal(a.hoursUsed, 166);
  assert.equal(a.coApprovedHrs, 20);
  // rate = (labor + burden dollars) / labor hours, over every line
  const bud = 1000 + 2000 + 3000 + 800 + 600 + 100;
  assert.equal(a.rateEst, Math.round((bud / 187) * 100) / 100);   // 187 = every labor line's budget hours
  assert.match(jbiDigest(d, a), /C\/O 002/);
});

test('rule proposals fill the sheet, skip zeros, mark soft ones, and report codes with no row', async () => {
  const t = await readTemplate(await makeTemplate());
  const fields = buildFields(t.grid, { choices: t.choices });
  const a = aggregateJbi(parseJbi(jbiRows())!);
  const { proposals, unmapped } = ruleProposals(fields, a, 'JBI.XLS');
  const by = Object.fromEntries(proposals.map((p) => [p.id, p]));
  assert.equal(by.B38.value, 150);               // 030 estimate hours
  assert.equal(by.C38.value, 130);               // 030 consumed hours
  assert.equal(by.C36, undefined, '008 has no hours: nothing proposed');
  assert.equal(by.G36.value, 6996);
  assert.equal(by.G36.confidence, 'medium');
  assert.equal(by.B38.confidence, 'high');
  assert.equal(by.C18.value, 160);
  assert.equal(by.C25.value, 166);
  assert.equal(by.C22.value, 12);
  assert.equal(by.C20.value, 20);
  assert.match(by.B38.source, /^JBI\.XLS: code 030/);
  assert.equal(by.B40.value, 10, 'exterior lights, code 100');
  assert.ok(proposals.every((p) => p.origin === 'rule'));
  assert.equal(unmapped.length, 1);
  assert.match(unmapped[0], /Code 700/);
});

/* ---------- from review to cells ---------- */
test('reviewed values become cell values: numbers parsed, dates as serials, choices enforced', async () => {
  const t = await readTemplate(await makeTemplate());
  const fields = buildFields(t.grid, { choices: t.choices });
  const { values, problems } = toCellValues(fields, { C18: '1,234.5', H6: '2025-09-10', B6: 'ANN PM', A3: '  #38005 TEST  ', C19: '', C25: 'abc', B7: 'NOBODY' });
  assert.equal(values.C18, 1234.5);
  assert.equal(values.H6, 45910);
  assert.equal(values.B6, 'ANN PM');
  assert.equal(values.A3, '#38005 TEST');
  assert.ok(!('C19' in values));
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /not a number/.test(p)) && problems.some((p) => /choices/.test(p)));
});

/* ---------- writing the workbook ---------- */
test('writing touches only the named cells: formulas, dropdowns, other sheets and styles survive', async () => {
  const tpl = await makeTemplate();
  const out = fillWorkbook(tpl, '50% CLOSE OUT ', { A3: '#38005 R&D <test>', B6: 'ANN PM', H6: 45910, C18: 53651, C12: 5, B38: 150, N38: 'Line one\nline two', A53: 'Distribution: Eaton was late', B47: 1234.5 });
  assert.deepEqual(out.skipped.map((s) => s.cell), ['C12']);
  assert.ok(out.skipped[0].reason.includes('formula'));
  assert.ok(!out.written.includes('C12'));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out.bytes as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('50% CLOSE OUT ')!;
  assert.equal(ws.getCell('A3').value, '#38005 R&D <test>');
  assert.equal(ws.getCell('B6').value, 'ANN PM');
  assert.equal(ws.getCell('H6').value instanceof Date ? (ws.getCell('H6').value as Date).toISOString().slice(0, 10) : ws.getCell('H6').value, '2025-09-10');
  assert.equal(ws.getCell('C18').value, 53651);
  assert.equal(ws.getCell('B38').value, 150);
  assert.equal(ws.getCell('B47').value, 1234.5);
  assert.equal(ws.getCell('N38').value, 'Line one\nline two');
  assert.equal(ws.getCell('C18').numFmt, '#,##0.00', 'the cell kept its number format');
  const f = ws.getCell('C12').value as { formula?: string };
  assert.equal(f.formula, 'C11', 'the formula in C12 is untouched');
  assert.equal((ws.getCell('D36').value as { formula?: string }).formula, 'C36-J36');
  assert.equal(ws.getCell('B6').dataValidation?.type, 'list', 'the dropdown survived');
  assert.equal(wb.getWorksheet('Sheet1')!.getCell('A2').value, 'BOB PM');

  // a quick-look preview must not show stale results; Excel is told to recalculate
  const zip = new PizZip(out.bytes);
  assert.match(zip.file('xl/workbook.xml')!.asText(), /fullCalcOnLoad="1"/);
  const sheetXml = zip.file('xl/worksheets/sheet2.xml')!.asText();
  assert.ok(!/<f>[^<]*<\/f><v>/.test(sheetXml), 'cached formula results were removed');
  assert.ok(sheetXml.includes('<f>C36-J36</f>'));
});

test('writing a second time over the first result still works (rows and cells already patched)', async () => {
  const first = fillWorkbook(await makeTemplate(), '50% CLOSE OUT ', { C18: 1, A53: 'one' });
  const second = fillWorkbook(first.bytes, '50% CLOSE OUT ', { C18: 2, A54: 'two' });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(second.bytes as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('50% CLOSE OUT ')!;
  assert.equal(ws.getCell('C18').value, 2);
  assert.equal(ws.getCell('A53').value, 'one');
  assert.equal(ws.getCell('A54').value, 'two');
  assert.throws(() => fillWorkbook(first.bytes, 'NO SUCH SHEET', { C18: 1 }), /no sheet named/);
});

/* ---------- reading documents ---------- */
test('PDF text keeps its columns so an amount stays under its heading', async () => {
  const items = (rows: [string, number, number][]) => rows.map(([str, x, y]) => ({ str, transform: [1, 0, 0, 1, x, y] }));
  const pdfjs: PdfjsLike = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: items([['Pending', 200, 700], ['Approved', 300, 700], ['601', 20, 680], ['$ 5,999.00', 200, 680], ['602', 20, 660], ['$ 91,161.00', 300, 660]]),
          }),
        }),
      }),
    }),
  };
  const { text } = await pdfToText(pdfjs, new Uint8Array(1));
  const lines = text.split('\n');
  const head = lines.find((l) => l.includes('Pending'))!;
  const r1 = lines.find((l) => l.includes('5,999'))!;
  const r2 = lines.find((l) => l.includes('91,161'))!;
  assert.ok(Math.abs(head.indexOf('Pending') - r1.indexOf('$')) <= 1, 'the first amount sits under Pending');
  assert.ok(Math.abs(head.indexOf('Approved') - r2.indexOf('$')) <= 1, 'the second sits under Approved');
});

test('Word text keeps paragraphs and tabs', () => {
  const zip = new PizZip();
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Foreman:</w:t></w:r><w:r><w:tab/><w:t>Tim &amp; crew</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>');
  assert.equal(docxToText(zip.generate({ type: 'uint8array' })), 'Foreman:\tTim & crew\nSecond');
});

/* ---------- the AI ---------- */
const aiFields = [
  { id: 'C13', group: 'Contract and profit', label: '50% meeting: contract value ($)', kind: 'number' as const, key: 'meeting50Contract' },
  { id: 'H6', group: 'Header', label: 'Meeting date', kind: 'date' as const, key: 'date' },
  { id: 'B6', group: 'Header', label: 'Project manager', kind: 'text' as const, key: 'pm', choices: ['ANN PM', 'BOB PM'] },
  { id: 'A53', group: 'Notes', label: 'Notes, row 53', kind: 'text' as const, key: 'note:majorPos' },
];
const baseReq = (): FillRequest => ({ job_id: '11111111-1111-4111-8111-111111111111', fields: aiFields, documents: [{ name: 'CO log.pdf', text: 'page text' }] });

test('the AI request lists every blank and document; scans go first as PDF documents', () => {
  const msg = buildUserMessage({ ...baseReq(), digest: 'JBI digest', instructions: 'This is the 50% meeting.' });
  assert.match(msg, /<document name="CO log.pdf">/);
  assert.match(msg, /C13 \| Contract and profit \| 50% meeting: contract value \(\$\) \| number/);
  assert.match(msg, /Choices: ANN PM; BOB PM/);
  assert.match(msg, /JBI digest/);
  assert.match(msg, /This is the 50% meeting\./);
  const content = buildContent({ ...baseReq(), attachments: [{ name: 'M25.pdf', data: 'QUJD' }] }) as { type: string }[];
  assert.equal(content[0].type, 'document');
  assert.equal(content[content.length - 1].type, 'text');
});

test("the AI's answer is checked: unknown blanks, bad numbers, bad dates, off-list choices and repeats are dropped", () => {
  const { proposals, dropped } = parseProposals({
    fields: [
      { id: 'C13', value: '$22,393,255.00', source: 'CO log p6', confidence: 'high' },
      { id: 'C13', value: 1, source: 'repeat', confidence: 'high' },
      { id: 'H6', value: '2025-09-10', source: 'notes', confidence: 'medium', note: 'from the header' },
      { id: 'B6', value: 'bob pm', source: 'notes', confidence: 'high' },
      { id: 'A53', value: '  Eaton   has been a disaster  ', source: 'foreman notes', confidence: 'weird' },
      { id: 'ZZ99', value: 5, source: 'x', confidence: 'high' },
      { id: 'H6', value: 'tomorrow', source: 'x', confidence: 'high' },
    ],
  }, aiFields);
  const by = Object.fromEntries(proposals.map((p) => [p.id, p]));
  assert.equal(by.C13.value, 22393255);
  assert.equal(by.H6.value, '2025-09-10');
  assert.equal(by.B6.value, 'BOB PM', 'a choice is matched to the template\'s own spelling');
  assert.equal(by.A53.value, 'Eaton has been a disaster');
  assert.equal(by.A53.confidence, 'low', 'an unknown confidence is treated as low');
  assert.equal(dropped, 3);
  const bad = (input: unknown) => assert.throws(() => parseProposals(input, aiFields), (e: unknown) => e instanceof HttpError && e.status === 502);
  bad(null); bad({}); bad({ fields: 'x' });
});

test('asking Claude: the key stays in the header, a tool answer comes back as proposals, failures say what to do', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_fields', input: { fields: [{ id: 'C13', value: 100, source: 'p1', confidence: 'high' }] } }] }), { status: 200 });
  };
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(askClaude(baseReq(), ok as typeof fetch), (e: unknown) => e instanceof HttpError && e.status === 503 && /ANTHROPIC_API_KEY/.test(e.message));
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const got = await askClaude(baseReq(), ok as typeof fetch);
  assert.equal(got[0].value, 100);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal((calls[0].init.headers as Record<string, string>)['x-api-key'], 'test-key');
  const sent = JSON.parse(calls[0].init.body as string);
  assert.equal(sent.tool_choice.name, 'submit_fields');
  assert.ok(!JSON.stringify(sent).includes('test-key'), 'the key is never in the body');

  const status = (code: number, body = '{}') => (async () => new Response(body, { status: code })) as unknown as typeof fetch;
  await assert.rejects(askClaude(baseReq(), status(401)), /key was not accepted/);
  await assert.rejects(askClaude(baseReq(), status(400, 'too long')), /Remove some documents/);
  await assert.rejects(askClaude(baseReq(), status(200, JSON.stringify({ stop_reason: 'max_tokens', content: [] }))), /ran out of room/);
  await assert.rejects(askClaude(baseReq(), status(200, JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }))), /did not give an answer/);
  delete process.env.ANTHROPIC_API_KEY;
});

test('a fill request is checked before it is stored', () => {
  const good = { job_id: '11111111-1111-4111-8111-111111111111', fields: aiFields, documents: [{ name: 'a.txt', text: 'hello\u0007' }], note_context: ['row 1: x'] };
  const v = validateFillRequest({ ...good });
  assert.equal(v.documents[0].text, 'hello', 'control characters are removed');
  const bad = (patch: Record<string, unknown>, re: RegExp) => assert.throws(() => validateFillRequest({ ...good, ...patch }), (e: unknown) => e instanceof HttpError && re.test(e.message));
  bad({ extra: 1 }, /Unknown field/);
  bad({ job_id: 'nope' }, /job id/);
  bad({ fields: [] }, /no blanks/);
  bad({ fields: [{ ...aiFields[0], id: 'c13; drop' }] }, /not valid/);
  bad({ fields: [aiFields[0], aiFields[0]] }, /not valid/);
  bad({ fields: [{ ...aiFields[0], kind: 'file' }] }, /unknown type/);
  bad({ documents: [] }, /at least one document/);
  bad({ documents: [{ name: 'big', text: 'x'.repeat(600_001) }] }, /limit/);
  bad({ documents: [], attachments: [{ name: 's.pdf', data: 'not base64!' }] }, /scanned/);
  bad({ documents: [], attachments: [{ name: 's.pdf', data: 'A'.repeat(3_700_000) }] }, /too big/);
  const withScan = validateFillRequest({ ...good, documents: [], attachments: [{ name: 's.pdf', data: 'QUJD' }] });
  assert.equal(withScan.attachments?.length, 1);
});

test('every Field has what the review screen needs', async () => {
  const t = await readTemplate(await makeTemplate());
  for (const f of buildFields(t.grid, { choices: t.choices }) as Field[]) {
    assert.match(f.id, /^[A-Z]{1,3}\d+$/);
    assert.ok(f.label && f.group && f.key);
    assert.ok(['number', 'text', 'date'].includes(f.kind));
    assert.ok(f.source === 'rule' || f.source === 'ai');
    if (f.source === 'rule' && f.key !== 'poComment') assert.equal(f.kind, 'number');
  }
});

/* ---------- working through a Claude Project ---------- */
test('the field list for a Project holds only the blanks the AI would answer, with cells, meaning and choices', async () => {
  const t = await readTemplate(await makeTemplate());
  const fields = buildFields(t.grid, { choices: t.choices });
  const list = fieldListForProject(fields, noteContext(t.grid), 'Closeout');
  assert.equal(list.fields.length, fields.filter((f) => f.source === 'ai').length);
  assert.ok(!list.fields.some((f) => f.cell === 'B38'), 'JBI-computed blanks are not listed');
  assert.ok(!list.fields.some((f) => ['B46', 'C46', 'G46'].includes(f.cell)), 'PO-log blanks are not listed');
  assert.ok(list.fields.some((f) => f.cell === 'E46'), "the change-order columns of the PO table are still listed");
  const pm = list.fields.find((f) => f.cell === 'B6')!;
  assert.deepEqual(pm.choices, ['ANN PM', 'BOB PM', 'CY PM']);
  assert.ok(list.fields.find((f) => f.cell === 'C19')!.meaning);
  assert.ok(list.note_rows.some((l) => l.includes('WHAT WENT WELL')));
});

test('a values file is read as JSON (plain, wrapped, fenced) or CSV with quoted commas and line breaks', () => {
  const a = parseImportText('[{"cell":"C13","value":5}]');
  assert.equal(a.rows[0].cell, 'C13');
  assert.equal(parseImportText('{"values":[{"id":"C13","value":5,"source":"s"}]}').rows[0].source, 's');
  assert.equal(parseImportText('```json\n{"values":[{"cell":"C13","value":5}]}\n```').rows.length, 1);
  const csv = parseImportText('cell,value,source,confidence,note\r\nA53,"Eaton, late ""again""",CO log,high,"two\nlines"\nC13,100,p1,low,');
  assert.equal(csv.rows[0].value, 'Eaton, late "again"');
  assert.equal(csv.rows[0].note, 'two\nlines');
  assert.equal(csv.rows[1].cell, 'C13');
  assert.match(parseImportText('{oops').error!, /not valid JSON/);
  assert.match(parseImportText('a,b\n1,2').error!, /"cell" and "value"/);
  assert.match(parseImportText('  ').error!, /empty/);
  assert.match(parseImportText('{"x":1}').error!, /No list/);
});

test('imported values are checked like the AI route: wrong cells, JBI cells, bad numbers, dates and choices are refused', async () => {
  const t = await readTemplate(await makeTemplate());
  const fields = buildFields(t.grid, { choices: t.choices });
  const { proposals, problems } = importProposals([
    { cell: 'c13', value: '$22,393,255', source: 'CO log', confidence: 'HIGH' },
    { cell: 'H6', value: '9/10/2025' },
    { cell: 'B6', value: 'bob pm' },
    { cell: 'A53', value: '  Eaton   was late ' },
    { cell: 'B38', value: 999 },             // computed from the JBI: refused
    { cell: 'ZZ9', value: 1 },
    { cell: 'C19', value: 'lots' },
    { cell: 'B7', value: 'NOBODY' },
    { cell: 'C13', value: 1 },               // repeat
    { cell: 'C20', value: '' },              // empty: skipped quietly
  ], fields);
  const by = Object.fromEntries(proposals.map((p) => [p.id, p]));
  assert.equal(by.C13.value, 22393255);
  assert.equal(by.C13.confidence, 'high');
  assert.equal(by.C13.origin, 'import');
  assert.equal(by.H6.value, '2025-09-10');
  assert.equal(by.B6.value, 'BOB PM');
  assert.equal(by.A53.value, 'Eaton was late');
  assert.equal(by.H6.confidence, 'medium', 'no stated confidence means "check"');
  assert.equal(proposals.length, 4);
  assert.equal(problems.length, 5);
  assert.ok(problems.some((p) => p.startsWith('B38') && /JBI/.test(p)));
});

test('a template whose title cell is empty and whose meeting type reads "100% CLOSEOUT" is still understood', async () => {
  const t = await readTemplate(await makeTemplate({ a3: null, a4: '100% CLOSEOUT', meetLabel: '100% CLOSEOUT:' }));
  const fields = buildFields(t.grid, { choices: { ...t.choices, A4: ['50% MEETING', '100% CLOSEOUT'] } });
  const title = fields.find((f) => f.key === 'title')!;
  assert.equal(title.id, 'A3', 'the title is the row above the meeting type, even when empty');
  assert.equal(title.current, undefined);
  const meet = fields.find((f) => f.key === 'meetingType')!;
  assert.equal(meet.id, 'A4');
  assert.equal(meet.current, '100% CLOSEOUT');
  assert.ok(fields.some((f) => f.id === 'C13' && f.key === 'meeting50Contract'), 'the contract row is found under its closeout label');
  assert.ok(!fields.some((f) => f.id === 'A4' && f.key === 'title'));
});

/* ---------- the PO log ---------- */
const poRows = (): unknown[][] => [
  ['PURCHASE ORDER LOG', '', '', '', '', '', '', ''],
  ['JOB. NO.', 37003, '(Non-Taxable)', '', '', '', '', ''],
  ['JOB NAME:', "CT CHILDREN'S MEDICAL CENTER", '', '', '', '', '', ''],
  ['', '', '', '', '', 'PHASE', 'PO TYPED ', 'terms'],
  ['DATE', 'PO #', 'VENDOR NAME', 'P/U ($)', '($) AMOUNT', 'CODE', '(Y/N)', ''],
  [44943, 700301, 'Cummins (Gen / ATSs)', 324500, 2080000, '0090', 'Y', ''],
  [44944, 700302, 'Graybar (Gear)', 103511, 1802238, '0030', 'Y', ''],
  [44945, 700303, 'Net Services (LV Systems)', 0, 0, '0300', 'Y', ''],
  [45754, 700304, 'Yale Electric (Lighting Warranty)', 5, 10, 1300, 'Y', ''],
  ['', '', '', '', '', '', '', ''],
  ['', '', '', 324500 + 103511 + 5, 2080000 + 1802238 + 10, '', '', ''],
];

test('a PO log is read: job, lines, codes, totals; a mismatch with its own total row is reported; other sheets are not PO logs', () => {
  assert.equal(parsePoLog([['a'], [1]]), null);
  assert.equal(parsePoLog(jbiRows()), null);
  const log = parsePoLog(poRows())!;
  assert.equal(log.job, '37003');
  assert.equal(log.jobName, "CT CHILDREN'S MEDICAL CENTER");
  assert.equal(log.lines.length, 4);
  assert.deepEqual(log.lines.map((l) => l.po), ['700301', '700302', '700303', '700304']);
  assert.deepEqual(log.lines.map((l) => l.code), ['090', '030', '300', '300'], '"0090" -> 090 and a numeric 1300 -> 300');
  assert.equal(log.lines[0].pickup, 324500);
  assert.equal(log.totals?.amount, 2080000 + 1802238 + 10);
  assert.deepEqual(log.warnings, []);
  const broken = poRows(); (broken[10] as unknown[])[4] = 5;
  assert.match(parsePoLog(broken)!.warnings[0], /total row says/);
});

const rowsFixture = () => [
  { row: 10, label: "030-GEAR ATS'", codes: ['030'] },
  { row: 11, label: '030-DISTRIBUTION', codes: ['030'] },
  { row: 12, label: '030-UPS', codes: ['030'] },
  { row: 13, label: '090-GENERATOR/ATS', codes: ['090'] },
  { row: 14, label: '110-BDA', codes: ['110'] },
  { row: 15, label: '110-FIRE ALARM', codes: ['110'] },
  { row: 16, label: '140-CABLE TRAY', codes: ['140'] },
  { row: 17, label: '140-TELE DATA', codes: ['140'] },
  { row: 18, label: '155-LIGHTNING PROTECTION', codes: ['155'] },
  { row: 19, label: '300-RIGGING', codes: ['300'] },
  { row: 20, label: '300-TESTING', codes: ['300'] },
];
const ln = (vendor: string, code: string, amount = 100, pickup = 10) => ({ po: '1', vendor, code, amount, pickup, terms: '' });

test('POs are matched to rows by code, then by the words in the vendor name; unclear ones are left to the person', () => {
  const m = matchPoLines([
    ln('Cummins (Gen / ATSs)', '090'),            // one row for the code
    ln('Graybar (Gear)', '030'),                  // gear fits two rows: not clear
    ln('Integ (UPS)', '031'),                     // no row for 031, but the name says UPS
    ln('TPC (Fire Alarm)', '110'),                // two rows for 110, the name picks one
    ln('Converge One (Cellular DAS)', '140'),     // two rows for 140, the name picks tele data
    ln('B&B Lightning Protection', '300'),        // the code points at rigging/testing, the name at lightning protection
    ln('Quick Pick Crane', '300'),                // crane = rigging
    ln('Consolidated (LV Systems)', '300'),       // nothing in the name helps
    ln('Net Services', '300', 0, 0),              // no amount
  ], rowsFixture());
  assert.deepEqual(m.map((x) => x.row), [13, null, 12, 15, 17, 18, 19, null, null]);
  assert.deepEqual(m.map((x) => x.confidence), ['high', 'low', 'medium', 'medium', 'medium', 'medium', 'medium', 'low', 'high']);
  assert.match(m[1].why, /4 rows|3 rows|choose/);
});

test('PO rows of the template are listed with their codes', async () => {
  const t = await readTemplate(await makeTemplate());
  const rows = poRowsOf(buildFields(t.grid, { choices: t.choices }));
  assert.deepEqual(rows.map((r) => [r.row, r.label, r.codes.join()]), [[46, '030-DISTRIBUTION', '030'], [47, '110-FIRE ALARM', '110'], [48, '300-TESTING', '300']]);
});

test('PO proposals: amounts added per row, budget = amount + P/U, vendors as the comment, unplaced and empty POs left out', async () => {
  const t = await readTemplate(await makeTemplate());
  const fields = buildFields(t.grid, { choices: t.choices });
  const lines = [ln('Graybar (Gear)', '030', 1000, 100), { ...ln('EW (Gear)', '030', 500, -50), po: '2' }, { ...ln('Loose Co', '300', 999, 1), po: '3' }, { ...ln('Zero', '110', 0, 0), po: '4' }];
  const p = poProposals(lines, [46, 46, null, 47], ['high', 'medium', 'low', 'high'], fields, 'PO.xls');
  const by = Object.fromEntries(p.map((x) => [x.id, x]));
  assert.equal(by.C46.value, 1500);                       // PO amount
  assert.equal(by.B46.value, 1100 + 450);                 // budget cost: amount + P/U, summed
  assert.equal(by.G46.value, 'Graybar; EW');              // comment: vendor names without the bracketed part
  assert.equal(by.C46.confidence, 'medium', 'one of the two was only a guess');
  assert.equal(by.B46.confidence, 'medium');
  assert.match(by.C46.note!, /2 POs/);
  assert.ok(!('C47' in by) && !('C48' in by), 'an empty PO and an unplaced PO add nothing');
  assert.ok(p.every((x) => x.origin === 'rule'));
});
