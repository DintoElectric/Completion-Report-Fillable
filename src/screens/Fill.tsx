import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle, Warning as WarningIcon, XCircle } from '@phosphor-icons/react';
import { MAX_SCAN_BYTES, RUN_GIVE_UP_MS, RUN_POLL_MS } from '../../shared/limits.ts';
import type { AiFieldRequest, FillRequest, FillRunRow, JobDetail, TemplateRow } from '../../shared/types.ts';
import {
  aggregateJbi, buildFields, checkTemplate, fieldListForProject, importProposals, jbiDigest, matchPoLines, noteContext, parseImportText, poProposals, poRowsOf, ruleProposals, toCellValues,
  type Field, type JbiData, type PoLog, type PoMatch, type PoRow, type Proposal, type Warning,
} from '../../shared/closeout.ts';
import { api, apiFire, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useFetch } from '../app/useFetch.ts';
import { navigate, paths } from '../app/router.ts';
import { TopBar, plural, useToast } from '../app/ui.tsx';
import { fetchFile, toBase64, uploadFile } from '../upload/files.ts';
import { readTemplate } from '../fill/template.ts';
import { extractSource } from '../fill/sources.ts';
import { fillWorkbook } from '../fill/writeXlsx.ts';

type StepState = 'wait' | 'run' | 'ok' | 'warn' | 'fail';
interface Step { key: string; label: string; state: StepState; detail?: string }

interface PoState { name: string; log: PoLog; rows: PoRow[]; assign: (number | null)[]; matches: PoMatch[]; manual: number[] }

interface Prepared {
  po?: PoState;
  fields: Field[];
  proposals: Record<string, Proposal>;
  warnings: Warning[];
  templateBytes: ArrayBuffer;
  sheetName: string;
  unmapped: string[];
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : e instanceof Error && e.message ? e.message : fallback);
const fmt = (v: string | number) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v);

/** Waits for the AI's answer, asking every few seconds. */
async function waitForRun(id: string, cancelled: () => boolean): Promise<FillRunRow> {
  const start = Date.now();
  for (;;) {
    if (cancelled()) throw new Error('Cancelled.');
    await new Promise((r) => setTimeout(r, RUN_POLL_MS));
    const { run } = await api<{ run: FillRunRow }>(`/fill/${id}`);
    if (run.status === 'ready' || run.status === 'failed') return run;
    if (Date.now() - start > RUN_GIVE_UP_MS) throw new Error('The AI is taking too long. Try again in a few minutes.');
  }
}

export default function Fill({ jobId }: { jobId: string }) {
  const { me } = useAuth();
  const toast = useToast();
  const { data, error } = useFetch<{ job: JobDetail }>(`/jobs/${jobId}`);
  const templates = useFetch<{ templates: TemplateRow[] }>('/templates');
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [instructions, setInstructions] = useState('');
  const [skipAi, setSkipAi] = useState(false);
  const [importMsgs, setImportMsgs] = useState<string[]>([]);
  const dead = useRef(false);
  useEffect(() => () => { dead.current = true; }, []);

  const job = data?.job;
  const template = templates.data?.templates.find((t) => t.id === job?.template_id) ?? null;
  const sources = job?.files.filter((f) => f.kind === 'source') ?? [];

  const setStep = (key: string, patch: Partial<Step>, label?: string) =>
    setSteps((all) => {
      const i = all.findIndex((s) => s.key === key);
      if (i < 0) return [...all, { key, label: label ?? key, state: 'run', ...patch }];
      return all.map((s, j) => (j === i ? { ...s, ...patch } : s));
    });

  const start = async () => {
    if (!job || !template?.file || !me) return;
    setBusy(true); setPrepared(null); setSteps([]); setProblems([]);
    try {
      if (template.file.file_type !== 'xlsx') throw new Error('Filling works with Excel (.xlsx) templates for now. Word and PDF templates come later.');

      setStep('template', { state: 'run' }, `Reading the template (${template.file.file_name})`);
      const templateBytes = await (await fetchFile(template.file)).arrayBuffer();
      const info = await readTemplate(templateBytes);
      const fields = buildFields(info.grid, { choices: info.choices });
      const warnings: Warning[] = checkTemplate(info.grid);
      if (!fields.length) throw new Error("This template doesn't look like the closeout sheet: no cost-code table or purchase-order list was found.");
      setStep('template', { state: warnings.length ? 'warn' : 'ok', detail: `${plural(fields.length, 'blank')} found${warnings.length ? `, ${plural(warnings.length, 'problem')} in the template's formulas` : ''}` });

      // documents
      let jbi: JbiData | null = null, jbiName = '';
      let poLog: PoLog | null = null, poName = '';
      const texts: { name: string; text: string }[] = [];
      const scans: { name: string; data: string; size: number }[] = [];
      for (const f of sources) {
        setStep(f.id, { state: 'run' }, `Reading ${f.file_name}`);
        const ab = await (await fetchFile(f)).arrayBuffer();
        const x = await extractSource(f.file_type, ab);
        if (x.kind === 'jbi') {
          if (jbi) { setStep(f.id, { state: 'warn', detail: 'A second JBI report was found. Only the first is used.' }); continue; }
          jbi = x.jbi; jbiName = f.file_name;
          warnings.push(...x.jbi.warnings.map((text) => ({ level: 'warn' as const, text: `${f.file_name}: ${text}` })));
          setStep(f.id, { state: 'ok', detail: `JBI report: ${plural(x.jbi.lines.length, 'line')}, ${plural(x.jbi.coTotals.length, 'change order')}` });
        } else if (x.kind === 'po') {
          if (poLog) { setStep(f.id, { state: 'warn', detail: 'A second PO log was found. Only the first is used.' }); continue; }
          poLog = x.po; poName = f.file_name;
          warnings.push(...x.po.warnings.map((text) => ({ level: 'warn' as const, text: `${f.file_name}: ${text}` })));
          setStep(f.id, { state: x.po.warnings.length ? 'warn' : 'ok', detail: `PO log for job ${x.po.job}: ${plural(x.po.lines.length, 'PO')}` });
        } else if (x.kind === 'text') {
          texts.push({ name: f.file_name, text: x.text });
          setStep(f.id, { state: 'ok', detail: `${Math.round(x.text.length / 1000).toLocaleString()}k characters of text` });
        } else if (x.kind === 'scan') {
          const used = scans.reduce((n, s) => n + s.size, 0);
          if (used + x.bytes.byteLength > MAX_SCAN_BYTES) setStep(f.id, { state: 'warn', detail: `A scanned PDF. Too big to send along with the others (limit ${(MAX_SCAN_BYTES / 1048576).toFixed(1)} MB for scans together), so it is left out.` });
          else { scans.push({ name: f.file_name, data: toBase64(x.bytes), size: x.bytes.byteLength }); setStep(f.id, { state: 'ok', detail: 'A scan: the AI will read the PDF itself' }); }
        } else {
          setStep(f.id, { state: 'warn', detail: x.reason });
        }
      }

      // numbers worked out from the JBI report
      const proposals: Record<string, Proposal> = {};
      let unmapped: string[] = [];
      let digest: string | undefined;
      const ruleFields = fields.filter((f) => f.source === 'rule');
      setStep('rules', { state: 'run' }, 'Working out the hours and dollars from the JBI report');
      if (jbi) {
        const agg = aggregateJbi(jbi);
        const r = ruleProposals(ruleFields, agg, jbiName);
        r.proposals.forEach((p) => { proposals[p.id] = p; });
        unmapped = r.unmapped;
        digest = jbiDigest(jbi, agg);
        setStep('rules', { state: unmapped.length ? 'warn' : 'ok', detail: `${plural(r.proposals.length, 'value')} worked out` });
      } else {
        setStep('rules', { state: 'warn', detail: "No JBI report was found among the documents, so the hours and dollars by cost code can't be worked out. Add the CF Data \"Budget/Cost Report\" export (.xls)." });
      }

      // purchase orders from the PO log
      let po: PoState | undefined;
      if (poLog) {
        const rows = poRowsOf(fields);
        const jobOf = (t: string) => /\d{4,6}/.exec(t)?.[0];
        if (jbi && jobOf(jbi.job) && poLog.job && jobOf(jbi.job) !== jobOf(poLog.job)) warnings.unshift({ level: 'warn', text: `The PO log is for job ${poLog.job} but the JBI report is for job ${jobOf(jbi.job)}. One of them is from the wrong job.` });
        setStep('po', { state: 'run' }, 'Placing the purchase orders on the sheet');
        if (!rows.length) {
          setStep('po', { state: 'warn', detail: 'The template has no purchase-order rows to fill.' });
        } else {
          const matches = matchPoLines(poLog.lines, rows);
          po = { name: poName, log: poLog, rows, assign: matches.map((m) => m.row), matches, manual: [] };
          poProposals(poLog.lines, po.assign, matches.map((m) => m.confidence), fields, poName).forEach((p) => { proposals[p.id] = p; });
          const loose = matches.filter((m, i) => m.row === null && (poLog!.lines[i].amount || poLog!.lines[i].pickup)).length;
          setStep('po', { state: loose ? 'warn' : 'ok', detail: loose ? `${plural(loose, 'PO')} still to place. Choose a row for each on the next screen.` : 'All purchase orders placed' });
        }
      } else if (fields.some((f) => f.key === 'poAmount')) {
        warnings.push({ level: 'info', text: 'No PO log was found among the documents, so the purchase-order budget costs and amounts are empty. Add the CF Data purchase order log (.xls) to fill them.' });
      }

      // everything else: the AI reads the documents
      const aiFields = fields.filter((f) => f.source === 'ai');
      if (!aiFields.length) {
        setStep('ai', { state: 'ok', detail: 'Nothing for the AI to read' }, 'The AI reads the documents');
      } else if (skipAi) {
        setStep('ai', { state: 'ok', detail: 'Skipped. Import a values file from a Claude Project on the next screen.' }, 'The AI reads the documents');
      } else if (!me.aiReady) {
        setStep('ai', { state: 'warn', detail: 'The AI is not set up yet. An admin needs to add ANTHROPIC_API_KEY in Netlify. You can still fill the numbers from the JBI report.' }, 'The AI reads the documents');
      } else if (!texts.length && !scans.length) {
        setStep('ai', { state: 'warn', detail: 'There are no documents with readable text besides the JBI report (such as the change order log), so the AI has nothing to read.' }, 'The AI reads the documents');
      } else {
        setStep('ai', { state: 'run', detail: 'Usually one to three minutes' }, 'The AI reads the documents');
        const req: FillRequest = {
          job_id: jobId,
          fields: aiFields.map((f): AiFieldRequest => ({ id: f.id, group: f.group, label: f.label, kind: f.kind, key: f.key, hint: f.hint, choices: f.choices })),
          documents: texts,
          attachments: scans.length ? scans.map(({ name, data }) => ({ name, data })) : undefined,
          digest,
          note_context: noteContext(info.grid),
          instructions: instructions.trim() || undefined,
        };
        try {
          const { run } = await api<{ run: FillRunRow }>('/fill', { body: req });
          await apiFire('/fill-background', { run_id: run.id });
          const done = await waitForRun(run.id, () => dead.current);
          if (done.status === 'failed') throw new Error(done.error ?? 'The AI could not read the documents.');
          for (const p of done.result ?? []) proposals[p.id] = { ...p, origin: 'ai' };
          setStep('ai', { state: 'ok', detail: `${plural(done.result?.length ?? 0, 'value')} found in the documents` });
        } catch (e) {
          if (dead.current) return;
          setStep('ai', { state: 'fail', detail: errText(e, 'The AI could not read the documents.') });
          warnings.push({ level: 'warn', text: `The AI step failed (${errText(e, 'unknown problem')}). Only the numbers from the JBI report are filled in. Go back and try again to retry.` });
        }
      }

      // the title defaults to the job's name in this app (the Project or AI may replace it)
      const title = fields.find((f) => f.key === 'title');
      if (title && title.current === undefined && !proposals[title.id] && job.name.trim()) {
        const name = job.name.trim();
        proposals[title.id] = { id: title.id, value: /^\d/.test(name) ? `#${name}` : name, source: "The job's name in this app", confidence: 'medium', note: 'Check the format, for example "#38005 YNHH SRC ED".', origin: 'rule' };
      }

      // start the review: proposals go in, except where the template already holds a value
      const initial: Record<string, string> = {};
      for (const f of fields) { const p = proposals[f.id]; if (p && f.current === undefined && p.value !== null) initial[f.id] = String(p.value); }
      if (dead.current) return;
      setValues(initial);
      setPrepared({ fields, proposals, warnings, templateBytes, sheetName: info.grid.name, unmapped, po });
    } catch (e) {
      if (dead.current) return;
      setSteps((all) => [...all.map((s) => (s.state === 'run' ? { ...s, state: 'fail' as const } : s)), { key: 'error', label: 'Stopped', state: 'fail', detail: errText(e, 'Something went wrong. Try again.') }]);
    } finally {
      if (!dead.current) setBusy(false);
    }
  };

  const assignPo = (i: number, row: number | null) => {
    if (!prepared?.po) return;
    const po = prepared.po;
    const assign = po.assign.slice(); assign[i] = row;
    const manual = po.manual.includes(i) ? po.manual : [...po.manual, i];
    const conf = assign.map((_, k) => (manual.includes(k) ? ('high' as const) : po.matches[k].confidence));
    const props = poProposals(po.log.lines, assign, conf, prepared.fields, po.name);
    const poField = (f: Field) => f.group === 'Purchase orders' && (f.key === 'budgetCost' || f.key === 'poAmount' || f.key === 'poComment');
    const nextP = { ...prepared.proposals }, nextV = { ...values };
    for (const f of prepared.fields) if (poField(f)) { delete nextP[f.id]; if (f.current === undefined) nextV[f.id] = ''; }
    for (const p of props) { nextP[p.id] = p; if (prepared.fields.find((f) => f.id === p.id)?.current === undefined) nextV[p.id] = String(p.value); }
    setPrepared({ ...prepared, proposals: nextP, po: { ...po, assign, manual } });
    setValues(nextV);
  };

  const downloadFieldList = async () => {
    if (!template?.file) return;
    try {
      const bytes = await (await fetchFile(template.file)).arrayBuffer();
      const info = await readTemplate(bytes);
      const list = fieldListForProject(buildFields(info.grid, { choices: info.choices }), noteContext(info.grid), template.name);
      const url = URL.createObjectURL(new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = `${template.name.replace(/[^\w.-]+/g, '-')}-field-list.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { toast(errText(e, "The field list couldn't be made.")); }
  };

  const importValues = async (file: File) => {
    if (!prepared) return;
    if (file.size > 2 * 1024 * 1024) { setImportMsgs(['That file is over 2 MB. A values file should be small; check you picked the right one.']); return; }
    const parsed = parseImportText(await file.text());
    if (parsed.error) { setImportMsgs([parsed.error]); return; }
    const { proposals, problems: bad } = importProposals(parsed.rows, prepared.fields);
    const nextP = { ...prepared.proposals };
    const nextV = { ...values };
    for (const p of proposals) {
      nextP[p.id] = p;
      const f = prepared.fields.find((x) => x.id === p.id)!;
      if (f.current === undefined) nextV[p.id] = String(p.value);
    }
    setPrepared({ ...prepared, proposals: nextP });
    setValues(nextV);
    setImportMsgs([`${plural(proposals.length, 'value')} imported from ${file.name}.`, ...bad]);
  };

  const save = async () => {
    if (!prepared || !job) return;
    const { values: cells, problems: bad } = toCellValues(prepared.fields, values);
    setProblems(bad);
    if (bad.length) return;
    if (!Object.keys(cells).length) { setProblems(['There is nothing to write yet. Fill in at least one value.']); return; }
    setSaving(0);
    try {
      const out = fillWorkbook(prepared.templateBytes, prepared.sheetName, cells);
      const stamp = new Date().toISOString().slice(0, 10);
      const safe = job.name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Job';
      const file = new File([out.bytes as BlobPart], `${safe} - closeout - ${stamp}.xlsx`, { type: XLSX_MIME });
      await uploadFile(file, { kind: 'output', job_id: jobId }, (p) => setSaving(p));
      await api(`/jobs/${jobId}`, { method: 'PATCH', body: { status: 'filled' } }).catch(() => undefined);   // only the job's creator or an admin may; the file is saved either way
      toast(out.skipped.length
        ? `Saved ${file.name}. ${plural(out.skipped.length, 'cell')} left alone because the template has a formula there.`
        : `Saved ${file.name}.`);
      navigate(paths.job(jobId));
    } catch (e) {
      setSaving(null);
      setProblems([errText(e, 'The file could not be created. Try again.')]);
    }
  };

  const crumbs = [{ label: 'Jobs', to: paths.jobs() }, { label: job?.name ?? '…', to: paths.job(jobId) }, { label: 'Fill the template' }];
  if (error) return (<><TopBar crumbs={crumbs} /><main className="page"><div className="page-inner"><p className="err-text">{error}</p></div></main></>);
  if (!job || !templates.data) return (<><TopBar crumbs={crumbs} /><main className="page"><div className="page-inner"><span className="spinner" /></div></main></>);

  const blocker = !me || me.role === 'viewer' ? 'Your account can look at jobs but not fill them. Ask an admin for member access.'
    : !template ? 'Pick the template on the job page first.'
    : !template.file ? 'This template has no file yet. An admin adds it on the Templates page.'
    : !sources.length ? 'Add the documents on the job page first, including the JBI report.' : null;

  return (
    <>
      <TopBar crumbs={crumbs}>
        <button className="btn btn-ghost" onClick={() => navigate(paths.job(jobId))}><ArrowLeft size={16} /> Back to the job</button>
      </TopBar>
      <main className="page">
        <div className="page-inner">
          <h1 className="h1">Fill the template</h1>

          {!prepared && (
            <section className="panel">
              <p style={{ margin: 0, fontSize: 14 }}>
                The app reads <b>{template?.name ?? 'the template'}</b> and {plural(sources.length, 'document')}. Hours and dollars by cost code are worked out from the JBI report, and the purchase-order budget costs and amounts from the PO log, with fixed rules.
                Everything else (job header, contract and profit, change orders, notes) is read from your documents by the AI. <b>Nothing goes into the file until you have looked at it.</b>
              </p>
              {me?.aiReady === false && <p className="err-text" style={{ margin: 0 }}>The AI is not set up yet (no ANTHROPIC_API_KEY in Netlify). Only the JBI numbers will be filled.</p>}
              <label className="field">Anything the AI should know? (optional)
                <textarea className="input" rows={2} value={instructions} maxLength={1000} disabled={busy} onChange={(e) => setInstructions(e.target.value)} placeholder="For example: this is the 50% meeting; treat CO 713 as pending, not approved." />
              </label>
              <label className="row" style={{ fontSize: 13, gap: 8 }}>
                <input type="checkbox" checked={skipAi} disabled={busy} onChange={(e) => setSkipAi(e.target.checked)} />
                Skip the AI here: I'll import a values file made in a Claude Project
              </label>
              <div><button type="button" className="link-btn" disabled={!template?.file} onClick={() => void downloadFieldList()}>Download the field list for a Claude Project</button></div>
              {blocker && <p className="err-text" style={{ margin: 0 }}>{blocker}</p>}
              <div className="row">
                <button className="btn btn-primary" disabled={busy || !!blocker} onClick={() => void start()}>{busy ? 'Working…' : steps.length ? 'Try again' : 'Read the documents'}</button>
                {busy && <span className="spinner" />}
              </div>
              <StepList steps={steps} />
            </section>
          )}

          {prepared && (
            <Review
              prepared={prepared} steps={steps} values={values} setValues={setValues}
              onSave={() => void save()} saving={saving} problems={problems} onImport={(f) => void importValues(f)} importMsgs={importMsgs} onAssignPo={assignPo}
              onRestart={() => { setPrepared(null); setSteps([]); }}
            />
          )}
        </div>
      </main>
    </>
  );
}

function StepList({ steps }: { steps: Step[] }) {
  if (!steps.length) return null;
  return (
    <ul className="steps">
      {steps.map((s) => (
        <li key={s.key} className={`step ${s.state}`}>
          <span className="step-icon">
            {s.state === 'run' ? <span className="spinner" /> : s.state === 'ok' ? <CheckCircle size={16} weight="fill" /> : s.state === 'warn' ? <WarningIcon size={16} weight="fill" /> : s.state === 'fail' ? <XCircle size={16} weight="fill" /> : null}
          </span>
          <span><span className="file-name">{s.label}</span>{s.detail && <span className="dim"> · {s.detail}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------- review ---------------- */
function Review({ prepared, steps, values, setValues, onSave, saving, problems, onRestart, onImport, importMsgs, onAssignPo }: {
  prepared: Prepared; steps: Step[]; values: Record<string, string>; setValues: (v: Record<string, string>) => void;
  onSave: () => void; saving: number | null; problems: string[]; onRestart: () => void; onImport: (f: File) => void; importMsgs: string[]; onAssignPo: (i: number, row: number | null) => void;
}) {
  const { fields, proposals, warnings, unmapped } = prepared;
  const groups: { name: string; fields: Field[] }[] = [];
  for (const f of fields) {
    const g = groups.find((x) => x.name === f.group);
    if (g) g.fields.push(f); else groups.push({ name: f.group, fields: [f] });
  }
  const set = (id: string, v: string) => setValues({ ...values, [id]: v });
  const filled = fields.filter((f) => (values[f.id] ?? '').trim() !== '').length;
  const fromJbi = fields.filter((f) => f.source === 'rule' && proposals[f.id]?.origin === 'rule').length;
  const fromAi = fields.filter((f) => proposals[f.id]?.origin === 'ai' || proposals[f.id]?.origin === 'import').length;
  const lowCount = fields.filter((f) => (values[f.id] ?? '').trim() !== '' && proposals[f.id] && proposals[f.id].confidence !== 'high').length;

  return (
    <>
      <section className="panel">
        <div className="row-between" style={{ flexWrap: 'wrap' }}>
          <h2 className="h2">Check the values</h2>
          <div className="row">
            <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
              Import a values file
              <input type="file" accept=".json,.csv,.txt" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); }} />
            </label>
            <button className="btn btn-ghost" onClick={onRestart}>Start over</button>
          </div>
        </div>
        {importMsgs.map((m, i) => <p key={i} className={i === 0 && /imported from/.test(m) ? 'dim' : 'warn-text'} style={{ margin: 0, fontSize: 13 }}>{m}</p>)}
        <p style={{ margin: 0, fontSize: 14 }}>
          <b>{plural(fromJbi, 'value')}</b> worked out from the JBI report and <b>{plural(fromAi, 'value')}</b> read from the documents by the AI or a Claude Project.
          {lowCount > 0 && <> <b>{plural(lowCount, 'value')}</b> {lowCount === 1 ? 'is' : 'are'} marked <span className="conf-tag medium">check</span> because the AI or the rule was not certain.</>}
          {' '}Change anything that is wrong. Empty boxes stay empty in the file. Hover over a value to see where it came from.
        </p>
        <StepList steps={steps} />
        {warnings.map((w, i) => <p key={i} className="warn-text"><WarningIcon size={14} weight="fill" /> {w.text}</p>)}
        {unmapped.map((u, i) => <p key={i} className="warn-text"><WarningIcon size={14} weight="fill" /> {u}</p>)}
      </section>

      {groups.map((g) => (
        <section className="panel" key={g.name}>
          <h2 className="h2">{g.name}</h2>
          {g.name === 'Purchase orders' && prepared.po && <PoPanel po={prepared.po} onAssign={onAssignPo} />}
          {g.name === 'Labor codes' || g.name === 'Purchase orders'
            ? <GridTable fields={g.fields} values={values} set={set} proposals={proposals} />
            : <div className="stack">{g.fields.map((f) => <FieldRow key={f.id} f={f} v={values[f.id] ?? ''} set={set} p={proposals[f.id]} />)}</div>}
        </section>
      ))}

      <section className="panel save-bar">
        {problems.map((p, i) => <p key={i} className="err-text" style={{ margin: 0 }}>{p}</p>)}
        <div className="row-between" style={{ flexWrap: 'wrap' }}>
          <span className="dim" style={{ fontSize: 13 }}>{plural(filled, 'value')} will be written. Formula cells in the template are never touched, and Excel recalculates every total when the file is opened.</span>
          <div className="row">
            {saving !== null && <span className="progress"><i style={{ width: `${Math.round(saving * 100)}%` }} /></span>}
            <button className="btn btn-primary" disabled={saving !== null} onClick={onSave}>{saving !== null ? 'Saving…' : 'Create the filled workbook'}</button>
          </div>
        </div>
      </section>
    </>
  );
}

/** Each line of the PO log, and the row of the sheet it goes to. Changing a row recalculates the purchase-order columns. */
function PoPanel({ po, onAssign }: { po: PoState; onAssign: (i: number, row: number | null) => void }) {
  const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const loose = po.log.lines.filter((l, i) => po.assign[i] === null && (l.amount || l.pickup));
  const looseAmt = loose.reduce((n, l) => n + l.amount, 0);
  return (
    <>
      <p className="dim" style={{ margin: 0, fontSize: 13 }}>
        From <b>{po.name}</b>. Each PO goes to one row. When several go to the same row they are added together. Budget cost is the log's Amount column and PO amount is its P/U column.
        Change a row below and the purchase-order columns update (anything you typed in those boxes is replaced).
      </p>
      {loose.length > 0 && <p className="warn-text"><WarningIcon size={14} weight="fill" /> {plural(loose.length, 'PO')} (${money(looseAmt)}) {loose.length === 1 ? 'is' : 'are'} not placed on any row, so {loose.length === 1 ? 'its' : 'their'} dollars are not counted.</p>}
      <div className="grid-scroll">
        <table className="table fill-grid">
          <thead><tr><th>PO #</th><th>Vendor</th><th>Code</th><th>Amount</th><th>P/U</th><th>Goes to</th></tr></thead>
          <tbody>
            {po.log.lines.map((l, i) => {
              const empty = !l.amount && !l.pickup;
              const m = po.matches[i];
              const user = po.manual.includes(i);
              return (
                <tr key={`${l.po}-${i}`}>
                  <td>{l.po}</td>
                  <td className="file-name">{l.vendor}</td>
                  <td>{l.code}</td>
                  <td>{money(l.amount)}</td>
                  <td>{money(l.pickup)}</td>
                  <td>
                    {empty ? <span className="dim">No amount</span> : (
                      <select className={`input fill-input${!user && m.confidence !== 'high' ? ' check' : ''}`} style={{ minWidth: 260 }} value={po.assign[i] ?? ''} title={user ? 'Chosen by you' : m.why} aria-label={`Row for PO ${l.po}`}
                        onChange={(e) => onAssign(i, e.target.value === '' ? null : Number(e.target.value))}>
                        <option value="">Not on the sheet</option>
                        {po.rows.map((r) => <option key={r.row} value={r.row}>{r.label}</option>)}
                      </select>
                    )}
                    {!empty && !user && m.confidence !== 'high' && <span className={`conf-tag ${m.row === null ? 'low' : 'medium'}`} title={m.why} style={{ marginLeft: 8 }}>{m.row === null ? 'choose' : 'check'}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Why({ f, p }: { f: Field; p?: Proposal }) {
  const cur = f.current !== undefined ? `The template already has ${fmt(f.current)} here, so nothing is written unless you type something. ` : '';
  if (!p) return cur ? <span className="dim why">{cur}</span> : null;
  return (
    <span className="why dim">
      {cur}{p.source}{p.note ? ` — ${p.note}` : ''}
    </span>
  );
}

function Input({ f, v, set, p }: { f: Field; v: string; set: (id: string, v: string) => void; p?: Proposal }) {
  const cls = `input fill-input${p && p.confidence !== 'high' ? ' check' : ''}`;
  const title = p ? `${p.source}${p.note ? `\n${p.note}` : ''}` : f.current !== undefined ? `The template already has ${fmt(f.current)} here` : undefined;
  if (f.choices) {
    return (
      <select className={cls} value={v} title={title} aria-label={f.label} onChange={(e) => set(f.id, e.target.value)}>
        <option value="">{f.current !== undefined ? `Keep: ${fmt(f.current)}` : ''}</option>
        {f.choices.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    );
  }
  return (
    <input
      className={cls} value={v} title={title} aria-label={f.label}
      inputMode={f.kind === 'number' ? 'decimal' : undefined}
      placeholder={f.current !== undefined ? `Keep: ${fmt(f.current)}` : f.kind === 'date' ? 'YYYY-MM-DD' : ''}
      onChange={(e) => set(f.id, e.target.value)}
    />
  );
}

function FieldRow({ f, v, set, p }: { f: Field; v: string; set: (id: string, v: string) => void; p?: Proposal }) {
  return (
    <div className="fill-row">
      <div className="fill-label">{f.label}{p && p.confidence !== 'high' && <span className={`conf-tag ${p.confidence}`}>{p.confidence === 'low' ? 'guess' : 'check'}</span>}</div>
      <Input f={f} v={v} set={set} p={p} />
      <Why f={f} p={p} />
    </div>
  );
}

/** Labor codes and purchase orders: one row per code or PO, one column per kind of value. */
function GridTable({ fields, values, set, proposals }: { fields: Field[]; values: Record<string, string>; set: (id: string, v: string) => void; proposals: Record<string, Proposal> }) {
  const split = (f: Field) => { const i = f.label.lastIndexOf(': '); return { row: f.label.slice(0, i), col: f.label.slice(i + 2) }; };
  const colOf = (id: string) => id.match(/^[A-Z]+/)![0].padStart(3, '@');
  const cols: { title: string; sort: string }[] = [];
  const rows = new Map<string, Map<string, Field>>();
  for (const f of fields) {
    const { row, col } = split(f);
    if (!cols.find((c) => c.title === col)) cols.push({ title: col, sort: colOf(f.id) });
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row)!.set(col, f);
  }
  cols.sort((a, b) => a.sort.localeCompare(b.sort));
  return (
    <div className="grid-scroll">
      <table className="table fill-grid">
        <thead><tr><th>Row</th>{cols.map((c) => <th key={c.title}>{c.title}</th>)}</tr></thead>
        <tbody>
          {[...rows.entries()].map(([row, cells]) => (
            <tr key={row}>
              <td className="file-name">{row}</td>
              {cols.map((c) => {
                const f = cells.get(c.title);
                return <td key={c.title} className={c.title === 'Comment' ? 'wide' : undefined}>{f ? <Input f={f} v={values[f.id] ?? ''} set={set} p={proposals[f.id]} /> : null}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
