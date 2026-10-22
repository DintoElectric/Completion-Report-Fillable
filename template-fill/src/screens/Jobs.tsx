import { useState } from 'react';
import { Plus } from '@phosphor-icons/react';
import type { JobRow, TemplateRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useFetch } from '../app/useFetch.ts';
import { navigate, paths } from '../app/router.ts';
import { Dialog, TopBar, fmtDate, plural } from '../app/ui.tsx';

export default function Jobs() {
  const { me } = useAuth();
  const { data, error, loading } = useFetch<{ jobs: JobRow[] }>('/jobs');
  const [creating, setCreating] = useState(false);
  const canCreate = me?.role !== 'viewer';
  return (
    <>
      <TopBar nav="jobs" />
      <main className="page">
        <div className="page-inner">
          <div className="row-between">
            <h1 className="h1">Jobs</h1>
            {canCreate && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> New job</button>}
          </div>
          {error && <p className="err-text">{error}</p>}
          {loading && !data && <span className="spinner" />}
          {data && data.jobs.length === 0 && (
            <div className="empty">
              <p>No jobs yet. A job is one document to fill: pick its template, add the spreadsheets and PDFs it's filled from, and download the result.</p>
              {canCreate && <button className="btn btn-primary" onClick={() => setCreating(true)}>Create the first job</button>}
            </div>
          )}
          {data && data.jobs.length > 0 && (
            <table className="table">
              <thead><tr><th>Name</th><th>Template</th><th className="right">Documents</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>
                {data.jobs.map((j) => (
                  <tr key={j.id} className="tr-click" onClick={() => navigate(paths.job(j.id))}>
                    <td><a href={paths.job(j.id)} onClick={(e) => { e.preventDefault(); navigate(paths.job(j.id)); }}>{j.name}</a></td>
                    <td className={j.template_name ? '' : 'dim'}>{j.template_name ?? 'None picked'}</td>
                    <td className="right num">{j.source_count}</td>
                    <td>{j.status === 'filled' ? <span className="tag tag-accent">Filled</span> : <span className="tag tag-neutral">Draft</span>}</td>
                    <td className="dim">{fmtDate(j.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data && data.jobs.length > 0 && <p className="dim" style={{ fontSize: 12 }}>{plural(data.jobs.length, 'job')}</p>}
        </div>
      </main>
      {creating && <NewJob onClose={() => setCreating(false)} />}
    </>
  );
}

function NewJob({ onClose }: { onClose: () => void }) {
  const templates = useFetch<{ templates: TemplateRow[] }>('/templates');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const { job } = await api<{ job: JobRow }>('/jobs', { body: { name, template_id: templateId || null } });
      navigate(paths.job(job.id));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'The job could not be created. Try again.'); setBusy(false); }
  };
  return (
    <Dialog title="New job" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }}>
        <label className="field">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Example: Yale OML pay application, October" /></label>
        <label className="field">Template
          <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Pick later</option>
            {templates.data?.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {err && <p className="err-text">{err}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>Create job</button>
        </div>
      </form>
    </Dialog>
  );
}
