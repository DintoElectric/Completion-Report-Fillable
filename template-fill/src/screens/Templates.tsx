import { useState } from 'react';
import { Archive, DownloadSimple, Plus, UploadSimple } from '@phosphor-icons/react';
import { acceptList, FILE_TYPES } from '../../shared/limits.ts';
import type { TemplateRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useFetch } from '../app/useFetch.ts';
import { Dialog, TopBar, fmtDate, plural, useToast } from '../app/ui.tsx';
import { checkFile, downloadFile, uploadFile } from '../upload/files.ts';

export default function Templates() {
  const { me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useFetch<{ templates: TemplateRow[] }>('/templates');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = me?.role === 'admin';

  const replaceFile = (t: TemplateRow) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = acceptList('template');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !me) return;
      const problem = await checkFile(file, 'template', me.limits.maxFileBytes);
      if (problem) return toast(problem);
      setBusy(t.id);
      try { await uploadFile(file, { kind: 'template', template_id: t.id }); toast(`${t.name} now uses ${file.name}.`); await reload(); } catch (e) { toast(e instanceof ApiError ? e.message : 'The upload stopped. Try again.'); } finally { setBusy(null); }
    };
    input.click();
  };
  const archive = async (t: TemplateRow) => {
    if (!confirm(`Archive ${t.name}? It leaves this list and can't be picked for new jobs. Jobs that already use it keep it.`)) return;
    try { await api(`/templates/${t.id}`, { method: 'DELETE' }); toast(`Archived ${t.name}.`); await reload(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Archiving failed. Try again.'); }
  };

  return (
    <>
      <TopBar nav="templates" />
      <main className="page">
        <div className="page-inner">
          <div className="row-between">
            <h1 className="h1">Templates</h1>
            {isAdmin && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> New template</button>}
          </div>
          {error && <p className="err-text">{error}</p>}
          {loading && !data && <span className="spinner" />}
          {data && data.templates.length === 0 && (
            <div className="empty"><p>{isAdmin ? 'No templates yet. Add the Word, Excel or PDF form that jobs will fill.' : 'No templates yet. An admin adds them here.'}</p></div>
          )}
          {data && data.templates.length > 0 && (
            <table className="table">
              <thead><tr><th>Name</th><th>File</th><th className="right">Jobs</th><th>Updated</th><th /></tr></thead>
              <tbody>
                {data.templates.map((t) => (
                  <tr key={t.id}>
                    <td><div>{t.name}</div>{t.description && <div className="dim" style={{ fontSize: 12 }}>{t.description}</div>}</td>
                    <td>{t.file ? <button className="link-btn" onClick={() => void downloadFile(t.file!).catch(() => toast("The template couldn't be downloaded."))}><DownloadSimple size={14} /> {t.file.file_name}</button> : <span className="dim">No file yet</span>}{t.file && <span className="dim" style={{ fontSize: 12 }}> · {FILE_TYPES[t.file.file_type]?.label}</span>}</td>
                    <td className="right num">{t.job_count}</td>
                    <td className="dim">{fmtDate(t.updated_at)}</td>
                    <td className="right">
                      {isAdmin && (
                        <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <button className="btn btn-ghost" onClick={() => replaceFile(t)} disabled={busy === t.id}><UploadSimple size={16} /> {busy === t.id ? 'Uploading…' : t.file ? 'Replace file' : 'Add file'}</button>
                          <button className="btn btn-ghost icon-btn" onClick={() => void archive(t)} aria-label={`Archive ${t.name}`} title="Archive"><Archive size={16} /></button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data && data.templates.length > 0 && <p className="dim" style={{ fontSize: 12 }}>{plural(data.templates.length, 'template')}</p>}
        </div>
      </main>
      {creating && <NewTemplate onClose={() => setCreating(false)} onDone={() => { setCreating(false); void reload(); }} />}
    </>
  );
}

function NewTemplate({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const save = async () => {
    if (!me) return;
    setErr(null);
    if (file) { const problem = await checkFile(file, 'template', me.limits.maxFileBytes); if (problem) return setErr(problem); }
    setProgress(0);
    try {
      const { template } = await api<{ template: TemplateRow }>('/templates', { body: { name, description: description || null } });
      if (file) await uploadFile(file, { kind: 'template', template_id: template.id }, setProgress);
      toast(`Added ${name}.`);
      onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'The template was not saved. Try again.'); setProgress(null); }
  };
  return (
    <Dialog title="New template" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void save(); }}>
        <label className="field">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Example: AIA G703 continuation sheet" /></label>
        <label className="field">What it's for (optional)<textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="field">File (Word, Excel or PDF)<input className="input" type="file" accept={acceptList('template')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        {progress !== null && <span className="progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>}
        {err && <p className="err-text">{err}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || progress !== null}>Add template</button>
        </div>
      </form>
    </Dialog>
  );
}
