import { useState } from 'react';
import { DownloadSimple, Trash } from '@phosphor-icons/react';
import { FILE_TYPES } from '../../shared/limits.ts';
import type { FileRow } from '../../shared/types.ts';
import { api, ApiError } from '../auth/api.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { downloadFile } from '../upload/files.ts';
import { fmtBytes, fmtDate, useToast } from '../app/ui.tsx';

/** A list of stored files, each with Download and (for whoever may) Delete. */
export function FileTable({ files, onChanged, empty }: { files: FileRow[]; onChanged: () => void; empty: string }) {
  const { me } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (!files.length) return <p className="dim" style={{ fontSize: 13, margin: 0 }}>{empty}</p>;
  const mayDelete = (f: FileRow) => me?.role === 'admin' || (f.kind !== 'template' && f.uploaded_by === me?.id);
  const download = async (f: FileRow) => {
    setBusy(f.id);
    try { await downloadFile(f); } catch (e) { toast(e instanceof ApiError ? e.message : "The file couldn't be downloaded. Try again."); } finally { setBusy(null); }
  };
  const remove = async (f: FileRow) => {
    if (!confirm(`Delete ${f.file_name}? This can't be undone.`)) return;
    setBusy(f.id);
    try { await api(`/files/${f.id}`, { method: 'DELETE' }); toast(`Deleted ${f.file_name}.`); onChanged(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Delete failed. Try again.'); } finally { setBusy(null); }
  };
  return (
    <table className="table">
      <thead><tr><th>Name</th><th>Type</th><th className="right">Size</th><th>Added</th><th /></tr></thead>
      <tbody>
        {files.map((f) => (
          <tr key={f.id}>
            <td className="file-name">{f.file_name}</td>
            <td className="dim">{FILE_TYPES[f.file_type]?.label ?? f.file_type}</td>
            <td className="right num dim">{fmtBytes(f.size_bytes)}</td>
            <td className="dim">{fmtDate(f.created_at)}{f.uploaded_by_name ? `, ${f.uploaded_by_name}` : ''}</td>
            <td className="right">
              <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost icon-btn" onClick={() => download(f)} disabled={busy === f.id} aria-label={`Download ${f.file_name}`} title="Download"><DownloadSimple size={16} /></button>
                {mayDelete(f) && <button className="btn btn-ghost icon-btn" onClick={() => remove(f)} disabled={busy === f.id} aria-label={`Delete ${f.file_name}`} title="Delete"><Trash size={16} /></button>}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
