// The browser side of file transfer. Files go up and come down in pieces (CHUNK_BYTES each): Netlify functions take
// about 6 MB per request, so a single request can't carry a large spreadsheet or scanned PDF.
import { api, apiBytes, ApiError } from '../auth/api.ts';
import { CHUNK_BYTES, FILE_TYPES, UPLOAD_RETRIES, fileTypeOf, limitMessages, magicMatches } from '../../shared/limits.ts';
import type { FileKind, FileRow } from '../../shared/types.ts';

export type UploadTarget = { kind: FileKind; job_id?: string; template_id?: string };

/** Checks a file before any upload starts, so a wrong file fails fast with a plain message. Returns the problem, or null. */
export async function checkFile(file: File, kind: FileKind, maxBytes: number): Promise<string | null> {
  const use = kind === 'template' ? 'template' : 'source';
  const type = fileTypeOf(file.name);
  if (!type || !FILE_TYPES[type][use]) return limitMessages.badType(use);
  if (file.size === 0) return 'This file is empty.';
  if (file.size > maxBytes) return limitMessages.tooBig(file.size, maxBytes);
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!magicMatches(type, head)) return limitMessages.notWhatItSays(FILE_TYPES[type].label);
  return null;
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < UPLOAD_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // a refusal (bad file, no permission) won't change on a retry; a dropped connection or a busy server might
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw last;
}

/** Uploads one file in pieces; onProgress gets 0..1. Resolves with the stored file once every piece has arrived. */
export async function uploadFile(file: File, target: UploadTarget, onProgress?: (p: number) => void): Promise<FileRow> {
  const { file: row } = await api<{ file: FileRow }>('/files/begin', { body: { ...target, file_name: file.name, size_bytes: file.size } });
  try {
    for (let i = 0; i < row.chunk_count; i++) {
      const piece = await file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer();
      await withRetries(() => api(`/files/${row.id}/chunk`, { body: { index: i, dataB64: toBase64(piece) } }));
      onProgress?.((i + 1) / (row.chunk_count + 1));
    }
    const { file: done } = await withRetries(() => api<{ file: FileRow }>(`/files/${row.id}/commit`, { method: 'POST', body: {} }));
    onProgress?.(1);
    return done;
  } catch (e) {
    // leave nothing half-stored behind (the hourly cleanup would catch it anyway)
    void api(`/files/${row.id}`, { method: 'DELETE' }).catch(() => undefined);
    throw e;
  }
}

/** Fetches a stored file's bytes, piece by piece. */
export async function fetchFile(f: Pick<FileRow, 'id' | 'chunk_count'>): Promise<Blob> {
  const parts: ArrayBuffer[] = [];
  for (let n = 0; n < f.chunk_count; n++) parts.push(await withRetries(() => apiBytes(`/files/${f.id}/chunk/${n}`)));
  return new Blob(parts);
}

/** Downloads a stored file to the person's computer under its own name. */
export async function downloadFile(f: Pick<FileRow, 'id' | 'chunk_count' | 'file_name'>): Promise<void> {
  const blob = await fetchFile(f);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.file_name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
