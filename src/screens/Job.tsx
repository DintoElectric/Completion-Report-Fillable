import { useState } from 'react';
import { DownloadSimple, MagicWand, Trash } from '@phosphor-icons/react';
import { acceptList } from '../../shared/limits.ts';
import type { JobDetail, TemplateRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useFetch } from '../app/useFetch.ts';
import { navigate, paths } from '../app/router.ts';
import { TopBar, plural, useToast } from '../app/ui.tsx';
import { Dropzone } from '../upload/Dropzone.tsx';
import { checkFile, downloadFile, uploadFile } from '../upload/files.ts';
import { FileTable } from './FileTable.tsx';

type Upload = { key: string; name: string; progress: number; error: string | null };

export default function Job({ jobId }: { jobId: string }) {
  const { me } = useAuth();
  const toast = useToast();
  const { data, error, reload } = useFetch<{ job: JobDetail }>(`/jobs/${jobId}`);
  const templates = useFetch<{ templates: TemplateRow[] }>('/templates');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const job = data?.job;
  const canEdit = !!me && !!job && (job.created_by === me.id || me.role === 'admin');
  const canUpload = !!me && me.role !== 'viewer';
  const template = templates.data?.templates.find((t) => t.id === job?.template_id) ?? null;

  const patch = async (body: Record<string, unknown>) => {
    try { await api(`/jobs/${jobId}`, { method: 'PATCH', body }); await reload(); } catch (e) { toast(e instanceof ApiError ? e.message : 'That change was not saved. Try again.'); }
  };

  const addFiles = async (files: File[]) => {
    if (!me) return;
    for (const file of files) {
      const key = `${file.name}-${Math.random()}`;
      const problem = await checkFile(file, 'source', me.limits.maxFileBytes);
      setUploads((u) => [...u, { key, name: file.name, progress: 0, error: problem }]);
      if (problem) continue;
      try {
        await uploadFile(file, { kind: 'source', job_id: jobId }, (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))));
        setUploads((u) => u.filter((x) => x.key !== key));
        await reload();
      } catch (e) {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: e instanceof ApiError ? e.message : 'The upload stopped. Try again.' } : x)));
      }
    }
  };

  const remove = async () => {
    if (!job || !confirm(`Delete the job "${job.name}" and all its documents? This can't be undone.`)) return;
    try { await api(`/jobs/${jobId}`, { method: 'DELETE' }); toast(`Deleted ${job.name}.`); navigate(paths.jobs()); } catch (e) { toast(e instanceof ApiError ? e.message : 'Delete failed. Try again.'); }
  };

  if (error) return (<><TopBar crumbs={[{ label: 'Jobs', to: paths.jobs() }, { label: 'Job' }]} /><main className="page"><div className="page-inner"><p className="err-text">{error}</p></div></main></>);
  if (!job) return (<><TopBar crumbs={[{ label: 'Jobs', to: paths.jobs() }, { label: '…' }]} /><main className="page"><div className="page-inner"><span className="spinner" /></div></main></>);

  const sources = job.files.filter((f) => f.kind === 'source');
  const outputs = job.files.filter((f) => f.kind === 'output');
  return (
    <>
      <TopBar crumbs={[{ label: 'Jobs', to: paths.jobs() }, { label: job.name }]}>
        {canEdit && <button className="btn btn-ghost" onClick={remove}><Trash size={16} /> Delete job</button>}
      </TopBar>
      <main className="page">
        <div className="page-inner">
          <h1 className="h1">{job.name}</h1>

          <section className="panel">
            <h2 className="h2">Template</h2>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <select className="input" style={{ maxWidth: 360 }} value={job.template_id ?? ''} disabled={!canEdit} onChange={(e) => void patch({ template_id: e.target.value || null })} aria-label="Template">
                <option value="">Pick the template this job fills</option>
                {templates.data?.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              {template?.file && <button className="btn btn-secondary" onClick={() => void downloadFile(template.file!).catch(() => toast("The template couldn't be downloaded."))}><DownloadSimple size={16} /> {template.file.file_name}</button>}
              {template && !template.file && <span className="dim" style={{ fontSize: 13 }}>This template has no file yet. An admin adds it on the Templates page.</span>}
            </div>
            {template?.description && <p className="dim" style={{ fontSize: 13, margin: 0 }}>{template.description}</p>}
          </section>

          <section className="panel">
            <div className="row-between"><h2 className="h2">Documents to fill it from</h2><span className="dim num" style={{ fontSize: 13 }}>{plural(sources.length, 'document')}</span></div>
            {canUpload && <Dropzone accept={acceptList('source')} title="Add documents" hint="Drop spreadsheets, PDFs, Word or CSV files here, or click to choose them." onFiles={(f) => void addFiles(f)} />}
            {uploads.map((u) => (
              <div key={u.key} className="row upload-row">
                <span className="file-name">{u.name}</span>
                {u.error ? <span className="err-text">{u.error}</span> : <span className="progress" aria-label={`Uploading ${u.name}`}><i style={{ width: `${Math.round(u.progress * 100)}%` }} /></span>}
                {u.error && <button className="btn btn-ghost" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>Dismiss</button>}
              </div>
            ))}
            <FileTable files={sources} onChanged={reload} empty="No documents yet." />
          </section>

          <section className="panel">
            <div className="row-between" style={{ flexWrap: 'wrap' }}>
              <h2 className="h2">Filled document</h2>
              {canUpload && (
                <button className="btn btn-primary" disabled={!template?.file || !sources.length} onClick={() => navigate(paths.fill(jobId))}>
                  <MagicWand size={16} /> Fill the template
                </button>
              )}
            </div>
            <p className="dim" style={{ fontSize: 13, margin: 0 }}>
              {!template ? 'Pick the template above, add the documents (including the JBI report), then fill it.' : !sources.length ? 'Add the documents above, then fill the template.' : 'Reads the documents and fills the template. You look over every value before the file is made.'}
            </p>
            <FileTable files={outputs} onChanged={reload} empty="Nothing filled yet." />
          </section>
        </div>
      </main>
    </>
  );
}
