import { getDatabase } from '@netlify/database';

let cached: ReturnType<typeof getDatabase> | null = null;

/** getDatabase() needs no configuration on Netlify; it resolves the branch for us. */
export function db() {
  if (!cached) cached = getDatabase();
  return cached;
}

/** Runs fn inside one transaction on a single pooled connection. */
export async function transaction<T>(fn: (q: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>): Promise<T> {
  const client = await db().pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((text, params) => client.query(text, params as unknown[]) as Promise<{ rows: any[] }>);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw e;
  } finally {
    client.release();
  }
}
