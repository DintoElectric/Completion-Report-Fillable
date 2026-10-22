// Re-export so functions import limits from one predictable place.
export * from '../../../shared/limits.ts';

import { MAX_FILE_BYTES } from '../../../shared/limits.ts';

/** MAX_FILE_MB env var overrides the per-file upload cap. */
export function maxFileBytes(): number {
  const mb = Number(process.env.MAX_FILE_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : MAX_FILE_BYTES;
}
