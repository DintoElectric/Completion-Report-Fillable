// One API client. Every request carries the Identity session cookie (same origin).
export const API_BASE = '/api';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function request(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, 'Your session has ended. Please sign in again.');
  }
  if (!res.ok) {
    let msg = 'Something went wrong. Please try again.';
    try {
      const j = await res.json();
      if (j?.error) msg = String(j.error);
    } catch {
      /* keep default message */
    }
    throw new ApiError(res.status, msg);
  }
  return res;
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; keepalive?: boolean } = {},
): Promise<T> {
  const res = await request(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    keepalive: opts.keepalive,
  });
  return (await res.json()) as T;
}

export async function apiBytes(path: string): Promise<ArrayBuffer> {
  const res = await request(path, { method: 'GET' });
  return res.arrayBuffer();
}

export async function apiPutBytes(path: string, bytes: Blob, contentType: string): Promise<void> {
  await request(path, { method: 'PUT', headers: { 'content-type': contentType }, body: bytes });
}

/** POST that only needs to be accepted (a background function answers 202 with no body). */
export async function apiFire(path: string, body: unknown): Promise<void> {
  await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
