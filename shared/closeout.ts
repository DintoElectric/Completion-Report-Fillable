// The closeout sheet's logic, with no browser or server code in it, so the browser, the functions and the tests share it.
//   1. A template is read into a plain SheetGrid (cells, merges).
//   2. buildFields() finds every cell a person or the AI may fill, by reading the sheet's own labels and column headings
//      (not fixed cell addresses), so an inserted row or a moved column does not break it. Formula cells are never fields.
//   3. parseJbi() + aggregateJbi() + ruleProposals() fill what is plain arithmetic on the JBI report. No AI is used for numbers
//      that can be computed.
//   4. checkTemplate() flags formulas in the template that look wrong.
//   5. toCellValues() turns the reviewed values into what is written into the workbook.

export type CellVal = string | number | null;
export interface GridCell { v: CellVal; f?: string }       // f = the formula text, when the cell holds a formula
export interface SheetGrid {
  name: string;
  cells: Record<string, GridCell>;
  merges: string[];                                          // e.g. "C6:G6"
  maxRow: number;
  maxCol: number;
}

/* ---------------- addresses ---------------- */
export const colNum = (L: string) => L.toUpperCase().split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
export function colLetter(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export const addr = (col: number, row: number) => `${colLetter(col)}${row}`;
export function splitAddr(a: string): { col: number; row: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(a);
  if (!m) throw new Error(`Not a cell address: ${a}`);
  return { col: colNum(m[1]), row: Number(m[2]) };
}

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const cellText = (g: SheetGrid, a: string) => norm(g.cells[a]?.v);

function mergeEndCol(g: SheetGrid, a: string): number {
  const { col, row } = splitAddr(a);
  for (const m of g.merges) {
    const [s, e] = m.split(':');
    const S = splitAddr(s), E = splitAddr(e ?? s);
    if (row >= S.row && row <= E.row && col >= S.col && col <= E.col) return E.col;
  }
  return col;
}
/** The cell to the right of a label, past the label's merged area. */
const cellRightOf = (g: SheetGrid, a: string) => addr(mergeEndCol(g, a) + 1, splitAddr(a).row);

/* ---------------- fields ---------------- */
export type FieldKind = 'number' | 'text' | 'date';
export type FieldSource = 'rule' | 'ai';

export interface Field {
  id: string;                 // the cell address on the closeout sheet
  group: string;              // heading in the review screen
  label: string;              // what a person reads
  kind: FieldKind;
  source: FieldSource;        // 'rule' = computed from the JBI report; 'ai' = read from the documents by the AI
  key: string;                // which rule or AI question this is
  codes?: string[];           // labor-code rows: the 3-digit JBI codes this row covers
  poCodes?: string[];         // purchase-order rows: the 3-digit cost codes in the row's name
  hint?: string;              // for the AI: what the cell means
  choices?: string[];         // the template only accepts these values (a dropdown)
  current?: string | number;  // already in the template (not a placeholder): left alone unless the person chooses to replace it
}

const PLACEHOLDER = /JOB NAME/i;

type Role = [string, RegExp];
const LABOR_ROLES: Role[] = [
  ['estHrs', /^(estimate|budget) hours?$/i],
  ['consHrs', /^consumed hrs/i],
  ['estMat', /^(estimate|budget) materials?$/i],
  ['consMat', /^consumed materials?/i],
  ['coHrs', /^approved co['’`]?s? hrs/i],
  ['coMat', /^approved co['’`]?s? materials?/i],
  ['comment', /^comments?$/i],
];
const PO_ROLES: Role[] = [
  ['budgetCost', /^budget cost/i],
  ['poAmount', /^po amount/i],
  ['coOut', /^approved co/i],
  ['coProc', /^completed/i],
  ['comment', /^comments?$/i],
];

const LABOR_LABEL: Record<string, string> = {
  estHrs: 'Estimate hours', consHrs: 'Consumed hours', estMat: 'Estimate materials ($)', consMat: 'Consumed materials ($)',
  coHrs: "Approved CO's hours", coMat: "Approved CO's materials ($)", comment: 'Comment',
};
const PO_LABEL: Record<string, string> = {
  budgetCost: 'Budget cost ($)', poAmount: 'PO amount ($)', coOut: "Approved CO's / out of contract ($)", coProc: "Completed & proceeding CO's ($)", comment: 'Comment',
};

function rolesOnRow(g: SheetGrid, row: number, roles: Role[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let c = 2; c <= g.maxCol; c++) {
    const t = cellText(g, addr(c, row));
    if (!t) continue;
    for (const [role, re] of roles) if (!(role in out) && re.test(t)) { out[role] = c; break; }
  }
  return out;
}

/** "050,100,101,115-LIGHTING" -> ["050","100","101","115"]; "3100-EXTERIOR" -> ["100"]; "040-300 MEDIUM VOLTAGE" -> ["040"]. */
export function codesOfLabel(label: string): string[] | null {
  const m = /^((?:\d{3,4}\s*,\s*)*\d{3,4})\s*-/.exec(label.trim());
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().slice(-3));
}

const NOTE_SECTIONS: { re: RegExp; key: string; title: string }[] = [
  { re: /MAJOR PO'?S/i, key: 'majorPos', title: "Major PO's & field installation notes" },
  { re: /PRE-?FAB\s*\/\s*SAFETY\s*\/\s*TOOLS/i, key: 'prefabSafetyTools', title: 'Pre-fab / safety / tools / other' },
  { re: /LESSONS LEARNED/i, key: 'lessons', title: 'Lessons learned' },
];
const MAX_NOTE_SLOTS = 14;

export interface BuildOptions { choices?: Record<string, string[]> }

export function buildFields(g: SheetGrid, opts: BuildOptions = {}): Field[] {
  const fields: Field[] = [];
  const A = (r: number) => cellText(g, `A${r}`);
  const rowWhere = (test: (r: number) => boolean, from = 1, to = g.maxRow) => { for (let r = from; r <= to; r++) if (test(r)) return r; return 0; };

  const add = (f: Omit<Field, 'current'> & { cellAddr?: string }) => {
    const cell = g.cells[f.id];
    if (cell?.f) return;                                      // never offer a formula cell
    const cur = cell?.v;
    const field: Field = { ...f };
    if (cur !== null && cur !== undefined && String(cur).trim() !== '' && !PLACEHOLDER.test(String(cur))) field.current = cur;
    fields.push(field);
  };

  const laborHdr = rowWhere((r) => /^LABOR COST CODES/i.test(A(r)));
  const topEnd = laborHdr || g.maxRow;

  /* header: job title, meeting type, PM, foreman, date */
  const MEETING = /MEETING|CLOSE\s?OUT/i;
  const meetRow = rowWhere((r) => MEETING.test(A(r)), 1, Math.min(8, topEnd));
  // the title is the row above the meeting type (it may be empty: the app fills it); older layouts: the first row with other text
  const titleRow = meetRow > 1 ? meetRow - 1 : rowWhere((r) => !!A(r) && !MEETING.test(A(r)), 1, Math.min(6, topEnd));
  if (titleRow) add({ id: `A${titleRow}`, group: 'Header', label: 'Job number and name', kind: 'text', source: 'ai', key: 'title', hint: "The job number and name as a title, like '#38005 YNHH SRC ED'." });
  if (meetRow && opts.choices?.[`A${meetRow}`]) add({ id: `A${meetRow}`, group: 'Header', label: 'Type of meeting', kind: 'text', source: 'ai', key: 'meetingType', hint: 'Which meeting this is. Choose from the choices; if no document says, leave it empty.', choices: opts.choices[`A${meetRow}`] });
  for (let r = 1; r < topEnd; r++) {
    for (const col of ['A', 'C']) {
      const t = cellText(g, `${col}${r}`);
      if (/^PM:?$/i.test(t)) { const id = cellRightOf(g, `${col}${r}`); add({ id, group: 'Header', label: 'Project manager', kind: 'text', source: 'ai', key: 'pm', hint: 'The project manager for this job. If choices are listed, the answer must be exactly one of them.', choices: opts.choices?.[id] }); }
      if (/^FOREMAN:?$/i.test(t)) { const id = cellRightOf(g, `${col}${r}`); add({ id, group: 'Header', label: 'Foreman', kind: 'text', source: 'ai', key: 'foreman', hint: 'The foreman on this job. If choices are listed, the answer must be exactly one of them.', choices: opts.choices?.[id] }); }
      if (/^DATE:?$/i.test(t)) { const id = cellRightOf(g, `${col}${r}`); add({ id, group: 'Header', label: 'Meeting date', kind: 'date', source: 'ai', key: 'date', hint: 'The date of the meeting, as YYYY-MM-DD, only if a document states it.' }); }
    }
  }

  /* contract and profit block */
  const cpRow = rowWhere((r) => /^CONTRACT$/i.test(cellText(g, `C${r}`)) && /^PROFIT/i.test(cellText(g, `D${r}`)), 1, topEnd);
  if (cpRow) {
    const rows: [RegExp, string, string, string][] = [
      [/^ORIGINAL CONTRACT/i, 'original', 'Original contract', 'The original (base) contract value, and the profit on it at the start.'],
      [/^(50% MEETING|100% CLOSE\s?OUT|CLOSE\s?OUT)/i, 'meeting50', 'Meeting value (50% or closeout)', "Today's contract value (base contract plus approved change orders) and the profit from the M25 report."],
      [/^FINAL VALUE/i, 'final', 'Final value', 'Only for the closeout meeting: the final contract value and final profit. Leave empty for a 50% meeting.'],
    ];
    for (let r = cpRow + 1; r < cpRow + 8 && r < topEnd; r++) {
      for (const [re, key, label, hint] of rows) {
        if (!re.test(A(r))) continue;
        add({ id: `C${r}`, group: 'Contract and profit', label: `${label}: contract value ($)`, kind: 'number', source: 'ai', key: `${key}Contract`, hint });
        add({ id: `D${r}`, group: 'Contract and profit', label: `${label}: profit ($)`, kind: 'number', source: 'ai', key: `${key}Profit`, hint });
      }
    }
  }

  /* labor summary */
  const summary: { re: RegExp; key: string; label: string; source: FieldSource; hint?: string }[] = [
    { re: /^HOURS ESTIMATED/i, key: 'hoursEstimated', label: 'Hours estimated', source: 'rule' },
    { re: /^CHANGE ORDERS:?\s*\(COMPLETED/i, key: 'coProcHrs', label: "Change orders (completed & proceeding): hours", source: 'ai', hint: "Total hours of change orders that are completed or proceeding but not yet approved, from the change order log. In the note, say which change orders you counted." },
    { re: /^CHANGE ORDERS:?\s*\(APPROVED/i, key: 'coApprovedHrs', label: 'Change orders (approved): hours', source: 'rule' },
    { re: /^PRE-?FAB USED/i, key: 'prefabUsed', label: 'Pre-fab hours used', source: 'rule' },
    { re: /^TOTAL HOURS USED/i, key: 'hoursUsed', label: 'Total hours used', source: 'rule' },
    { re: /^JOB AVERAGE RATE ESTIMATE/i, key: 'rateEst', label: 'Job average rate: estimate ($/hr)', source: 'rule' },
    { re: /^JOB AVERAGE RATE ACTUAL/i, key: 'rateAct', label: 'Job average rate: actual ($/hr)', source: 'rule' },
  ];
  for (let r = 1; r < topEnd; r++) {
    for (const col of ['A', 'B']) {
      const t = cellText(g, `${col}${r}`);
      for (const s of summary) {
        if (!s.re.test(t)) continue;
        add({ id: cellRightOf(g, `${col}${r}`), group: 'Labor summary', label: s.label, kind: 'number', source: s.source, key: s.key, hint: s.hint });
        if (s.key === 'coProcHrs') {
          for (let c = 3; c <= g.maxCol; c++) {
            if (/^MATERIALS$/i.test(cellText(g, addr(c, r)))) {
              add({ id: cellRightOf(g, addr(c, r)), group: 'Labor summary', label: "Change orders (completed & proceeding): materials ($)", kind: 'number', source: 'ai', key: 'coProcMat', hint: "Total material dollars of those same change orders, only if the log or another document gives it. Otherwise leave empty." });
              break;
            }
          }
        }
      }
    }
  }

  /* labor cost codes */
  if (laborHdr) {
    const roles = rolesOnRow(g, laborHdr, LABOR_ROLES);
    const totalRow = rowWhere((r) => /^TOTAL HOURS/i.test(A(r)), laborHdr + 1) || g.maxRow + 1;
    for (let r = laborHdr + 1; r < totalRow; r++) {
      const label = A(r);
      const codes = codesOfLabel(label);
      if (!codes) continue;
      for (const [role] of LABOR_ROLES) {
        const col = roles[role];
        if (!col) continue;
        const id = addr(col, r);
        if (role === 'comment') {
          add({ id, group: 'Labor codes', label: `${label}: comment`, kind: 'text', source: 'ai', key: 'laborComment', codes, hint: 'A short remark about this cost code, only if a document says something specific about it. Otherwise leave out.' });
        } else {
          add({ id, group: 'Labor codes', label: `${label}: ${LABOR_LABEL[role]}`, kind: 'number', source: 'rule', key: role, codes });
        }
      }
    }
  }

  /* purchase orders: budget cost, PO amount and the vendor comment come from the PO log; the change-order columns are read from the documents */
  const poHdr = rowWhere((r) => /^PURCHASE ORDER/i.test(A(r)), laborHdr || 1);
  if (poHdr) {
    const roles = rolesOnRow(g, poHdr, PO_ROLES);
    for (let r = poHdr + 1; r <= g.maxRow && A(r); r++) {
      const label = A(r);
      const poCodes = codesOfLabel(label) ?? [];
      for (const [role] of PO_ROLES) {
        const col = roles[role];
        if (!col) continue;
        const id = addr(col, r);
        if (role === 'comment') {
          add({ id, group: 'Purchase orders', label: `${label}: comment`, kind: 'text', source: 'rule', key: 'poComment', poCodes, hint: 'The vendor name(s), from the PO log.' });
        } else if (role === 'budgetCost' || role === 'poAmount') {
          add({ id, group: 'Purchase orders', label: `${label}: ${PO_LABEL[role]}`, kind: 'number', source: 'rule', key: role, poCodes, hint: role === 'poAmount' ? "The log's P/U column." : "The log's AMOUNT column." });
        } else {
          const hints: Record<string, string> = {
            coOut: "Change order / out-of-contract dollars for this item, from approved change orders.",
            coProc: "Dollars for this item in completed and proceeding change orders.",
          };
          add({ id, group: 'Purchase orders', label: `${label}: ${PO_LABEL[role]}`, kind: 'number', source: 'ai', key: role, poCodes, hint: hints[role] });
        }
      }
    }
  }

  /* notes sections: every empty row under a section heading is a slot for one line of text */
  const heads = NOTE_SECTIONS.map((s) => ({ ...s, row: rowWhere((r) => s.re.test(A(r)), poHdr || laborHdr || 1) })).filter((s) => s.row).sort((a, b) => a.row - b.row);
  heads.forEach((s, i) => {
    const end = (heads[i + 1]?.row ?? g.maxRow + 1) - 1;
    let n = 0;
    for (let r = s.row + 1; r <= end && n < MAX_NOTE_SLOTS; r++) {
      const c = g.cells[`A${r}`];
      if (c?.f) continue;
      if (norm(c?.v)) continue;                               // printed labels and existing text stay as they are
      add({ id: `A${r}`, group: s.title, label: `${s.title}, row ${r}`, kind: 'text', source: 'ai', key: `note:${s.key}`, hint: 'One line of text (under 220 characters).' });
      n++;
    }
  });

  return fields;
}

/** The printed text of rows around the note slots, so the AI can see which label ("WHAT WENT WELL:") each empty row sits under. */
export function noteContext(g: SheetGrid): string[] {
  const out: string[] = [];
  const A = (r: number) => cellText(g, `A${r}`);
  let on = false;
  for (let r = 1; r <= g.maxRow; r++) {
    const t = A(r);
    if (NOTE_SECTIONS.some((s) => s.re.test(t))) { on = true; out.push(`row ${r}: [SECTION] ${t}`); continue; }
    if (on && t) out.push(`row ${r}: ${t.length > 120 ? `${t.slice(0, 120)}…` : t}`);
  }
  return out;
}

/* ---------------- template checks ---------------- */
export interface Warning { level: 'warn' | 'info'; text: string }

/** Flags formulas in the template that look wrong. Today: a TOTAL row whose SUM range stops short of the rows it totals. */
export function checkTemplate(g: SheetGrid): Warning[] {
  const out: Warning[] = [];
  const A = (r: number) => cellText(g, `A${r}`);
  const find = (re: RegExp, from = 1) => { for (let r = from; r <= g.maxRow; r++) if (re.test(A(r))) return r; return 0; };
  const sumRange = (a: string) => {
    const f = g.cells[a]?.f;
    const m = f && /^=?SUM\(\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)\)$/i.exec(f.replace(/\s+/g, ''));
    return m && m[1].toUpperCase() === m[3].toUpperCase() ? { start: Number(m[2]), end: Number(m[4]) } : null;
  };
  // one warning per distinct short range, naming every column it affects
  const report = (what: string, totalRow: number, first: number, last: number) => {
    const groups = new Map<string, string[]>();
    for (let c = 2; c <= g.maxCol; c++) {
      const r = sumRange(addr(c, totalRow));
      if (r && (r.start > first || r.end < last)) {
        const k = `${r.start}-${r.end}`;
        groups.set(k, [...(groups.get(k) ?? []), colLetter(c)]);
      }
    }
    for (const [k, cols] of groups) {
      const [s, e] = k.split('-');
      out.push({ level: 'warn', text: `${what}: the total row (${cols.map((c) => `${c}${totalRow}`).join(', ')}) adds rows ${s} to ${e}, but the list runs from row ${first} to row ${last}. Anything outside that range is left out of the total. Fix the formula in the template.` });
    }
  };

  const laborHdr = find(/^LABOR COST CODES/i);
  if (laborHdr) {
    const totalRow = find(/^TOTAL HOURS/i, laborHdr + 1);
    let first = 0, last = 0;
    for (let r = laborHdr + 1; r < (totalRow || g.maxRow); r++) if (codesOfLabel(A(r))) { first ||= r; last = r; }
    if (totalRow && first) report('Labor cost codes', totalRow, first, last);
  }
  const poHdr = find(/^PURCHASE ORDER/i);
  if (poHdr) {
    let last = poHdr;
    while (last + 1 <= g.maxRow && A(last + 1)) last++;
    if (last > poHdr) report('Purchase orders', last + 1, poHdr + 1, last);
  }
  return out;
}

/* ---------------- JBI report ---------------- */
export interface JbiLine {
  cat: string; pre: string; code: string; type: string; desc: string;
  budDol: number; cost: number; budHrs: number; hrs: number;
  section: 'contract' | 'co'; co?: string;
}
export interface JbiCoTotal { co: string; desc: string; budDol: number; budHrs: number; hrs: number }
export interface JbiData {
  job: string; customer: string; date: string;
  lines: JbiLine[];
  contractTotal: { budDol: number; cost: number; budHrs: number; hrs: number } | null;
  finalTotal: { budDol: number; cost: number; budHrs: number; hrs: number } | null;
  coTotals: JbiCoTotal[];
  warnings: string[];
}

const toNum = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const CAT_RE = /^(\d)(\d{3}) ([A-Z])$/;

/** Reads a CF Data "Budget/Cost Report" exported to Excel (rows as arrays). Returns null when the rows are not that report. */
export function parseJbi(rows: unknown[][]): JbiData | null {
  const hdr = rows.findIndex((r) => norm(r[0]) === 'Cat #');
  if (hdr < 0 || !rows.slice(0, hdr).some((r) => r.some((c) => /Budget\/Cost Report/i.test(String(c ?? ''))))) return null;
  const d: JbiData = { job: '', customer: '', date: '', lines: [], contractTotal: null, finalTotal: null, coTotals: [], warnings: [] };
  for (let i = 0; i < hdr; i++) {
    const t = norm(rows[i][0]);
    if (/^DATE\b/i.test(t)) d.date = t.replace(/^DATE\s*/i, '');
    if (/JOB #/i.test(String(rows[i][1] ?? ''))) { d.job = norm(rows[i + 1]?.[1]); d.customer = norm(rows[i + 1]?.[3]); }
  }
  let section: 'contract' | 'co' = 'contract';
  let co = '', coDesc = '';
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    const a = norm(r[0]), b = norm(r[1]);
    const m = CAT_RE.exec(a);
    if (m) {
      d.lines.push({ cat: a, pre: m[1], code: m[2], type: m[3], desc: b, budDol: toNum(r[2]), cost: toNum(r[3]), budHrs: toNum(r[5]), hrs: toNum(r[6]), section, co: section === 'co' ? co : undefined });
      continue;
    }
    const totals = { budDol: toNum(r[2]), cost: toNum(r[3]), budHrs: toNum(r[5]), hrs: toNum(r[6]) };
    if (b.includes('****CONTRACT TOTAL')) { d.contractTotal = totals; section = 'co'; continue; }
    if (b.includes('****FINAL TOTAL')) { d.finalTotal = totals; continue; }
    if (b.includes('****C/O TOTAL')) { d.coTotals.push({ co, desc: coDesc, budDol: totals.budDol, budHrs: totals.budHrs, hrs: totals.hrs }); continue; }
    if (/^C\/O\s+\S+/.test(a)) { section = 'co'; co = a; coDesc = b; }
  }
  if (!d.lines.length) return null;
  if (!d.contractTotal) d.warnings.push("The report has no CONTRACT TOTAL line, so contract and change-order amounts can't be told apart. Export it again from CF Data.");
  if (!d.coTotals.length) d.warnings.push("The report shows no change-order sections. In CF Data, tick \"Combine C/O's With Base Job\" before exporting.");
  if (!d.finalTotal) d.warnings.push('The report has no FINAL TOTAL line, so total hours used is added up from the lines.');
  return d;
}

export interface CodeTotals { estHrs: number; consHrs: number; estMat: number; consMat: number; coHrs: number; coMat: number }
const zero = (): CodeTotals => ({ estHrs: 0, consHrs: 0, estMat: 0, consMat: 0, coHrs: 0, coMat: 0 });

export interface JbiAggregate {
  byCode: Record<string, CodeTotals>;
  hoursEstimated: number;
  hoursUsed: number;
  coApprovedHrs: number;
  prefabHrs: number;
  rateEst: number | null;
  rateAct: number | null;
}

/**
 * The rules, learned from the old sheets and their tutorial:
 *  - the three-digit code is the last three digits of the JBI category ("1030 M" is code 030); a leading 9 is pre-fab and is kept apart
 *  - labor (type L) gives hours; every other type except burden (B) is material dollars (M, O, S, P ...)
 *  - estimate = the contract section's Budget columns; approved CO = the change-order sections' Budget columns
 *  - consumed = the actual columns of every section (the change-order sections hold their own actuals)
 *  - job average rate = labor + burden dollars divided by labor hours, over every line
 */
export function aggregateJbi(d: JbiData): JbiAggregate {
  const byCode: Record<string, CodeTotals> = {};
  let prefabHrs = 0, bL = 0, bB = 0, cL = 0, cB = 0, bh = 0, ch = 0;
  for (const l of d.lines) {
    if (l.type === 'L') { bL += l.budDol; cL += l.cost; bh += l.budHrs; ch += l.hrs; }
    if (l.type === 'B') { bB += l.budDol; cB += l.cost; }
    if (l.pre === '9') { if (l.type === 'L') prefabHrs += l.hrs; continue; }
    const t = (byCode[l.code] ??= zero());
    const co = l.section === 'co';
    if (l.type === 'L') {
      t.consHrs += l.hrs;
      if (co) t.coHrs += l.budHrs; else t.estHrs += l.budHrs;
    } else if (l.type !== 'B') {
      t.consMat += l.cost;
      if (co) t.coMat += l.budDol; else t.estMat += l.budDol;
    }
  }
  const sumCo = Object.values(byCode).reduce((n, t) => n + t.coHrs, 0);
  return {
    byCode,
    hoursEstimated: d.contractTotal?.budHrs ?? Object.values(byCode).reduce((n, t) => n + t.estHrs, 0),
    hoursUsed: d.finalTotal?.hrs ?? ch,
    coApprovedHrs: sumCo,
    prefabHrs,
    rateEst: bh ? round2((bL + bB) / bh) : null,
    rateAct: ch ? round2((cL + cB) / ch) : null,
  };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Proposal {
  id: string;
  value: string | number | null;
  source: string;                  // where it came from, in words
  confidence: 'high' | 'medium' | 'low';
  note?: string;
  origin: 'rule' | 'ai' | 'import';   // import = a values file made in a Claude Project
}

const ROLE_SOURCE: Record<string, string> = {
  estHrs: 'estimate labor hours (contract section, Budget Hrs)',
  consHrs: 'actual labor hours (all sections)',
  estMat: 'estimate material dollars (contract section, Budget Dollars)',
  consMat: 'actual material cost (all sections; every type except labor and burden)',
  coHrs: 'change-order labor hours (change-order sections, Budget Hrs)',
  coMat: 'change-order material dollars (change-order sections, Budget Dollars)',
};

const MATERIAL_NOTE: Record<string, string> = {
  consMat: 'Adds every cost type except labor (L) and burden (B). If part of this is already tracked on the purchase-order list below, take it out here.',
  coMat: 'Change-order Budget Dollars for every type except labor and burden. Check against the change-order log.',
  coHrs: 'Change-order Budget Hrs by code. Check against the change-order log.',
};

/** Values computed from the JBI report for every 'rule' field. Zero amounts are left empty (the sheet's formulas treat blank as 0). */
export function ruleProposals(fields: Field[], agg: JbiAggregate, jbiName: string): { proposals: Proposal[]; unmapped: string[] } {
  const proposals: Proposal[] = [];
  const claimed = new Set<string>();
  const push = (id: string, value: number | null, source: string, note?: string, confidence: Proposal['confidence'] = 'high') => {
    if (value === null || value === 0) return;
    proposals.push({ id, value, source: `${jbiName}: ${source}`, confidence, note, origin: 'rule' });
  };
  for (const f of fields) {
    if (f.source !== 'rule') continue;
    if (f.codes) {
      f.codes.forEach((c) => claimed.add(c));
      const key = f.key as keyof CodeTotals;
      const sum = f.codes.reduce((n, c) => n + (agg.byCode[c]?.[key] ?? 0), 0);
      const soft = f.key === 'consMat' || f.key === 'coMat' || f.key === 'coHrs';
      push(f.id, round2(sum), `code ${f.codes.join(', ')}, ${ROLE_SOURCE[f.key]}`, soft ? MATERIAL_NOTE[f.key] : undefined, soft ? 'medium' : 'high');
      continue;
    }
    switch (f.key) {
      case 'hoursEstimated': push(f.id, agg.hoursEstimated, 'CONTRACT TOTAL, Budget Hrs'); break;
      case 'coApprovedHrs': push(f.id, agg.coApprovedHrs, 'sum of the approved change-order hours by code'); break;
      case 'prefabUsed': push(f.id, agg.prefabHrs, 'labor hours under pre-fab codes (9xxx)'); break;
      case 'hoursUsed': push(f.id, agg.hoursUsed, 'FINAL TOTAL, actual hours'); break;
      case 'rateEst': push(f.id, agg.rateEst, 'labor + burden budget dollars ÷ budget hours, all lines'); break;
      case 'rateAct': push(f.id, agg.rateAct, 'labor + burden actual cost ÷ actual hours, all lines'); break;
    }
  }
  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const unmapped = Object.entries(agg.byCode)
    .filter(([code, t]) => !claimed.has(code) && Object.values(t).some((v) => Math.abs(v) > 0.005))
    .map(([code, t]) => {
      const parts = [
        t.estHrs && `${t.estHrs} estimate hrs`, t.consHrs && `${t.consHrs} hrs used`, t.coHrs && `${t.coHrs} change-order hrs`,
        t.estMat && `${money(t.estMat)} estimated materials`, t.consMat && `${money(t.consMat)} material cost`, t.coMat && `${money(t.coMat)} change-order materials`,
      ].filter(Boolean);
      return `Code ${code} has ${parts.join(', ')} in the JBI report but no row on this sheet, so it is not counted anywhere.`;
    });
  return { proposals, unmapped };
}

/** A short plain-text digest of the JBI report for the AI, so it can match change orders to codes without being sent hundreds of lines. */
export function jbiDigest(d: JbiData, agg: JbiAggregate): string {
  const lines = [
    `JBI Budget/Cost Report: ${d.job}${d.customer ? ` (customer: ${d.customer})` : ''}${d.date ? `, dated ${d.date}` : ''}`,
    d.contractTotal ? `Contract total: budget ${Math.round(d.contractTotal.budDol)} dollars, ${d.contractTotal.budHrs} budget hours, ${d.contractTotal.hrs} actual hours.` : '',
    d.finalTotal ? `Final total (with change orders): ${d.finalTotal.budHrs} budget hours, ${d.finalTotal.hrs} actual hours.` : '',
    `Hours used ${agg.hoursUsed}; approved change-order hours by code total ${agg.coApprovedHrs}.`,
    'Change orders in the JBI report (number, description, budget dollars, budget hours):',
    ...d.coTotals.map((c) => `  ${c.co} | ${c.desc} | ${Math.round(c.budDol)} | ${c.budHrs}`),
  ];
  return lines.filter(Boolean).join('\n');
}

/* ---------------- values to write ---------------- */
/** Excel stores dates as days since 1899-12-30. */
export function excelSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(ms)) return null;
  return Math.round((ms - Date.UTC(1899, 11, 30)) / 86400000);
}

/** Parses what a person typed into a number cell: "$1,234.50", "(88)", "-12". Returns null when it isn't a number. */
export function parseNumberInput(s: string): number | null {
  let t = s.trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[$,\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(t) && !/^-?\d+\.$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** From the reviewed values to {cell: value to write}. A blank value writes nothing. Dates become Excel serials. */
export function toCellValues(fields: Field[], reviewed: Record<string, string>): { values: Record<string, number | string>; problems: string[] } {
  const values: Record<string, number | string> = {};
  const problems: string[] = [];
  for (const f of fields) {
    const raw = reviewed[f.id];
    if (raw === undefined || raw.trim() === '') continue;
    if (f.kind === 'number') {
      const n = parseNumberInput(raw);
      if (n === null) { problems.push(`${f.label}: "${raw}" is not a number.`); continue; }
      values[f.id] = n;
    } else if (f.kind === 'date') {
      const s = excelSerial(raw);
      if (s === null) { problems.push(`${f.label}: use a date like 2026-12-31.`); continue; }
      values[f.id] = s;
    } else {
      if (f.choices && !f.choices.includes(raw)) { problems.push(`${f.label}: "${raw}" is not one of the choices in the template.`); continue; }
      values[f.id] = raw.trim();
    }
  }
  return { values, problems };
}

/* ---------------- working with a Claude Project instead of the API ---------------- */
/** What a Project needs to answer in cell terms: the blanks the AI would be asked about, with their meaning. */
export function fieldListForProject(fields: Field[], notes: string[], templateName: string) {
  return {
    template: templateName,
    how_to_answer: 'Return values only for blanks the documents support. Use each blank\'s "cell" exactly as listed.',
    note_rows: notes,
    fields: fields.filter((f) => f.source === 'ai').map((f) => ({
      cell: f.id, section: f.group, label: f.label, type: f.kind,
      ...(f.hint ? { meaning: f.hint } : {}), ...(f.choices ? { choices: f.choices } : {}),
    })),
  };
}

export interface ImportRow { cell: string; value: unknown; source?: unknown; confidence?: unknown; note?: unknown }

/** Reads a values file: JSON (a list, or {values|fields|rows: [...]}, even inside a ``` fence) or CSV with a header row. */
export function parseImportText(text: string): { rows: ImportRow[]; error?: string } {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (!t) return { rows: [], error: 'The file is empty.' };
  const fence = /^```[a-z]*\s*\n([\s\S]*?)\n```\s*$/i.exec(t);
  const body = fence ? fence[1] : t;
  if (body.startsWith('[') || body.startsWith('{')) {
    try {
      const j = JSON.parse(body) as unknown;
      const list = Array.isArray(j) ? j : ((j as Record<string, unknown>)?.values ?? (j as Record<string, unknown>)?.fields ?? (j as Record<string, unknown>)?.rows);
      if (!Array.isArray(list)) return { rows: [], error: 'No list of values was found in the file.' };
      return { rows: list.filter((r) => r && typeof r === 'object').map((r: Record<string, unknown>) => ({ cell: String(r.cell ?? r.id ?? ''), value: r.value, source: r.source, confidence: r.confidence, note: r.note })) };
    } catch { return { rows: [], error: 'The file is not valid JSON. Ask the Project to give it again.' }; }
  }
  // CSV (RFC 4180: quoted fields may hold commas, quotes and line breaks)
  const recs: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === '"') { if (body[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && body[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim())) recs.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) recs.push(row);
  const head = (recs[0] ?? []).map((h) => h.trim().toLowerCase());
  const ci = (n: string[]) => head.findIndex((h) => n.includes(h));
  const [iCell, iVal] = [ci(['cell', 'id']), ci(['value'])];
  if (iCell < 0 || iVal < 0) return { rows: [], error: 'The file needs a header row with "cell" and "value" columns.' };
  const [iSrc, iConf, iNote] = [ci(['source']), ci(['confidence']), ci(['note'])];
  return { rows: recs.slice(1).map((r) => ({ cell: r[iCell] ?? '', value: r[iVal], source: iSrc >= 0 ? r[iSrc] : undefined, confidence: iConf >= 0 ? r[iConf] : undefined, note: iNote >= 0 ? r[iNote] : undefined })) };
}

const isoOf = (v: string): string | null => {
  const t = v.trim();
  if (excelSerial(t) !== null) return t.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};

/** Checks imported rows against the template's blanks. Only blanks meant for the AI are accepted: the JBI numbers are never overwritten. */
export function importProposals(rows: ImportRow[], fields: Field[]): { proposals: Proposal[]; problems: string[] } {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: Proposal[] = [], problems: string[] = [], seen = new Set<string>();
  for (const r of rows) {
    const id = String(r.cell ?? '').trim().toUpperCase();
    if (r.value === undefined || r.value === null || String(r.value).trim() === '') continue;
    const f = byId.get(id);
    if (!f) { problems.push(`${id || '(no cell)'}: this is not a blank on the template, so it was ignored.`); continue; }
    if (f.source === 'rule') { problems.push(`${id} (${f.label}): the app fills this one from the JBI report or the PO log, so the file's value was ignored.`); continue; }
    if (seen.has(id)) { problems.push(`${id}: given twice; the first value was used.`); continue; }
    let value: string | number | null = null;
    if (f.kind === 'number') value = typeof r.value === 'number' ? r.value : parseNumberInput(String(r.value));
    else if (f.kind === 'date') value = isoOf(String(r.value));
    else {
      const t = String(r.value).replace(/\s+/g, ' ').trim().slice(0, 600);
      value = f.choices ? (f.choices.find((c) => c.toLowerCase() === t.toLowerCase()) ?? null) : t;
    }
    if (value === null || (typeof value === 'number' && !Number.isFinite(value))) { problems.push(`${id} (${f.label}): "${String(r.value).slice(0, 40)}" is not ${f.kind === 'number' ? 'a number' : f.kind === 'date' ? 'a date' : 'one of the choices'}, so it was ignored.`); continue; }
    seen.add(id);
    const c = String(r.confidence ?? '').toLowerCase();
    out.push({
      id, value, origin: 'import',
      source: String(r.source ?? '').trim().slice(0, 200) || 'Values file from a Project',
      confidence: c === 'high' || c === 'medium' || c === 'low' ? c : 'medium',
      note: String(r.note ?? '').trim().slice(0, 300) || undefined,
    });
  }
  return { proposals: out, problems };
}

/* ---------------- the purchase order (PO) log ---------------- */
export interface PoLine {
  po: string; vendor: string; pickup: number; amount: number;
  code: string;            // the three-digit cost code ("0090" -> "090")
  terms: string;
}
export interface PoLog { job: string; jobName: string; lines: PoLine[]; totals: { pickup: number; amount: number } | null; warnings: string[] }

const poText = (v: unknown) => (typeof v === 'number' ? String(Math.round(v)) : norm(v));

/** Reads the CF Data "Purchase Order Log" exported to Excel. Returns null when the rows are not that log. */
export function parsePoLog(rows: unknown[][]): PoLog | null {
  const h = rows.findIndex((r) => norm(r[0]).toUpperCase() === 'DATE' && /^PO\s*#/i.test(norm(r[1])) && /VENDOR/i.test(norm(r[2])));
  if (h < 0 || !rows.slice(0, h).some((r) => /PURCHASE ORDER LOG/i.test(norm(r[0])))) return null;
  const log: PoLog = { job: '', jobName: '', lines: [], totals: null, warnings: [] };
  for (const r of rows.slice(0, h)) {
    if (/^JOB\.?\s*NO/i.test(norm(r[0]))) log.job = poText(r[1]);
    if (/^JOB NAME/i.test(norm(r[0]))) log.jobName = norm(r[1]);
  }
  for (const r of rows.slice(h + 1)) {
    const po = poText(r[1]);
    if (!po) {
      if (!norm(r[2]) && (toNum(r[3]) || toNum(r[4]))) log.totals = { pickup: toNum(r[3]), amount: toNum(r[4]) };
      continue;
    }
    const raw = poText(r[5]).replace(/\D/g, '');
    log.lines.push({ po, vendor: norm(r[2]), pickup: toNum(r[3]), amount: toNum(r[4]), code: raw ? raw.padStart(3, '0').slice(-3) : '', terms: norm(r[7]) });
  }
  if (!log.lines.length) return null;
  if (log.totals) {
    const a = log.lines.reduce((n, l) => n + l.amount, 0), p = log.lines.reduce((n, l) => n + l.pickup, 0);
    if (Math.abs(a - log.totals.amount) > 1 || Math.abs(p - log.totals.pickup) > 1) {
      log.warnings.push(`The PO lines add up to $${Math.round(a).toLocaleString('en-US')} (pick-up $${Math.round(p).toLocaleString('en-US')}), but the log's own total row says $${Math.round(log.totals.amount).toLocaleString('en-US')} (pick-up $${Math.round(log.totals.pickup).toLocaleString('en-US')}). Check that the whole log was exported.`);
    }
  }
  return log;
}

export interface PoRow { row: number; label: string; codes: string[] }

/** The purchase-order rows of the template, in order. */
export function poRowsOf(fields: Field[]): PoRow[] {
  return fields.filter((f) => f.group === 'Purchase orders' && f.key === 'poAmount').map((f) => ({
    row: splitAddr(f.id).row, label: f.label.slice(0, f.label.lastIndexOf(': ')), codes: f.poCodes ?? [],
  }));
}

export interface PoMatch { row: number | null; confidence: 'high' | 'medium' | 'low'; why: string }

// Words that mean the same thing on a vendor name and a row name.
const SAME: string[][] = [
  ['gear', 'distribution', 'switchgear', 'switchboard', 'switchboards', 'panelboard', 'panelboards'],
  ['fire', 'alarm', 'fa'],
  ['bda', 'das', 'cellular', 'antenna'],
  ['lightning'],
  ['lighting', 'light', 'lights', 'fixture', 'fixtures', 'controls'],
  ['security', 'access', 'camera', 'cameras'],
  ['crane', 'rigging', 'rig', 'hoist', 'lift', 'lifts', 'rentals'],
  ['test', 'testing'],
  ['scan', 'scanning'],
  ['ups'],
  ['battery', 'batteries'],
  ['feeder', 'feeders'],
  ['seismic'],
  ['permit', 'permits'],
  ['bond'],
  ['generator', 'generators', 'gen'],
  ['tele', 'data', 'telecom', 'das', 'cellular'],
  ['nurse'],
  ['sound', 'masking'],
  ['wiremold'],
  ['devices', 'device'],
  ['duct'],
  ['inverter'],
  ['conduit', 'boxes'],
  ['pole', 'poles', 'bases'],
  ['tray'],
  ['safety'],
  ['tax', 'taxable'],
];
const wordGroups = (s: string): Set<number> => {
  const out = new Set<number>();
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2) continue;
    SAME.forEach((g, i) => { if (g.includes(w)) out.add(i); });
  }
  return out;
};

/**
 * Proposes which template row each PO belongs to. The cost code on the log is the strongest sign; when a code has several rows
 * (030, 110, 300 ...) or none, the words in the vendor name decide. If that is not clear the PO is left unassigned for the person to place.
 */
export function matchPoLines(lines: PoLine[], rows: PoRow[]): PoMatch[] {
  const score = (l: PoLine, r: PoRow) => { const v = wordGroups(l.vendor), w = wordGroups(r.label); let n = 0; v.forEach((g) => { if (w.has(g)) n++; }); return n; };
  const best = (l: PoLine, from: PoRow[]) => {
    const sc = from.map((r) => ({ r, n: score(l, r) })).sort((a, b) => b.n - a.n);
    return sc[0] && sc[0].n > 0 && (!sc[1] || sc[1].n < sc[0].n) ? sc[0].r : null;
  };
  return lines.map((l): PoMatch => {
    if (!l.amount && !l.pickup) return { row: null, confidence: 'high', why: 'No amount on this PO.' };
    const byCode = rows.filter((r) => r.codes.includes(l.code));
    if (byCode.length === 1) return { row: byCode[0].row, confidence: 'high', why: `Code ${l.code} has one row.` };
    if (byCode.length > 1) {
      const b = best(l, byCode);
      if (b) return { row: b.row, confidence: 'medium', why: `Code ${l.code}, and the vendor name fits "${b.label}".` };
    }
    const any = best(l, rows);
    if (any) return { row: any.row, confidence: 'medium', why: `Matched on the vendor name (the log says code ${l.code || '?'}).` };
    return { row: null, confidence: 'low', why: byCode.length ? `Code ${l.code} has ${byCode.length} rows: choose one.` : `No row for code ${l.code || '?'}: choose one, or leave it off the sheet.` };
  });
}

/**
 * Budget cost, PO amount and vendor comment for each template row, from the PO log lines assigned to it.
 * Budget cost = the log's ($) AMOUNT column; PO amount = the log's P/U ($) column. The sheet's own formula then shows budget minus PO.
 */
export function poProposals(lines: PoLine[], assign: (number | null)[], conf: ('high' | 'medium' | 'low')[], fields: Field[], logName: string): Proposal[] {
  const byRow = new Map<number, number[]>();
  assign.forEach((row, i) => { if (row !== null && row !== undefined && (lines[i].amount || lines[i].pickup)) byRow.set(row, [...(byRow.get(row) ?? []), i]); });
  const idOf = (key: string, row: number) => fields.find((f) => f.group === 'Purchase orders' && f.key === key && splitAddr(f.id).row === row)?.id;
  const out: Proposal[] = [];
  for (const [row, idx] of byRow) {
    const budget = round2(idx.reduce((n, i) => n + lines[i].amount, 0));     // the log's AMOUNT column
    const poAmt = round2(idx.reduce((n, i) => n + lines[i].pickup, 0));      // the log's P/U column
    const pos = idx.map((i) => `PO ${lines[i].po}`).join(', ');
    const sure = idx.every((i) => conf[i] === 'high');
    const vendors = [...new Set(idx.map((i) => lines[i].vendor.replace(/\s*\(.*$/, '').trim() || lines[i].vendor))].join('; ').slice(0, 200);
    const idA = idOf('poAmount', row), idB = idOf('budgetCost', row), idC = idOf('poComment', row);
    const note = idx.length > 1 ? `${idx.length} POs added together.` : undefined;
    if (idB && budget) out.push({ id: idB, value: budget, source: `${logName}: ${pos}, AMOUNT column`, confidence: sure ? 'high' : 'medium', note, origin: 'rule' });
    if (idA && poAmt) out.push({ id: idA, value: poAmt, source: `${logName}: ${pos}, P/U column`, confidence: sure ? 'high' : 'medium', note, origin: 'rule' });
    if (idC && vendors) out.push({ id: idC, value: vendors, source: `${logName}: ${pos}`, confidence: 'high', origin: 'rule' });
  }
  return out;
}
