import { HttpError } from './http.ts';
import { MAX_STR } from '../../../shared/limits.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function uuid(v: unknown, label = 'id'): string {
  if (!isUuid(v)) throw new HttpError(400, `The ${label} is not valid.`);
  return v.toLowerCase();
}

export function str(
  v: unknown,
  label: string,
  opts: { required?: boolean; max?: number } = {},
): string | null {
  const { required = false, max = MAX_STR } = opts;
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${label} is required.`);
    return null;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${label} must be text.`);
  const t = v.trim();
  if (!t) {
    if (required) throw new HttpError(400, `${label} is required.`);
    return null;
  }
  if (t.length > max) throw new HttpError(400, `${label} is too long (the limit is ${max} characters).`);
  return t;
}

export function reqStr(v: unknown, label: string, max = MAX_STR): string {
  return str(v, label, { required: true, max }) as string;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], label: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new HttpError(400, `${label} must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

export function num(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new HttpError(400, `${label} must be a number between ${min} and ${max}.`);
  }
  return v;
}

export function int(v: unknown, label: string, min: number, max: number): number {
  const n = num(v, label, min, max);
  if (!Number.isInteger(n)) throw new HttpError(400, `${label} must be a whole number.`);
  return n;
}

/** Rejects unknown fields (spec 2.8: "reject unknown fields"). */
export function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new HttpError(400, `Unknown field "${k}".`);
  }
}

export function dateOnly(v: unknown, label: string): string | null {
  const s = str(v, label, { max: 10 });
  if (s === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new HttpError(400, `${label} must be a date like 2026-12-31.`);
  }
  return s;
}
