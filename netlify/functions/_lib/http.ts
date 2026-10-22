import type { Context } from '@netlify/functions';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * Path segments after the resource prefix. Works for both the public
 * `/api/<resource>/...` URL and the raw `/.netlify/functions/<resource>/...`
 * URL, so it does not matter which one the runtime reports for a rewrite.
 * Result: [resource, ...rest].
 */
export function segments(req: Request): string[] {
  const path = new URL(req.url).pathname;
  const m = path.match(/\/(?:api|\.netlify\/functions)\/(.*)$/);
  return (m ? m[1] : '').split('/').filter(Boolean).map(decodeURIComponent);
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
    return body as T;
  } catch {
    throw new HttpError(400, 'The request body must be a JSON object.');
  }
}

type Handler = (req: Request, ctx: Context) => Promise<Response>;

/** Wraps a handler so every failure becomes `{ error }` with a plain message. */
export function handle(fn: Handler): Handler {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      // The database library wraps the real Postgres error in `cause`, so look there too.
      const wrapped = e as { code?: string; cause?: { code?: string; message?: string } } | null;
      const code = wrapped?.code ?? wrapped?.cause?.code;
      if (code === '23505') return json({ error: 'That already exists.' }, 409);
      if (code === '23503') return json({ error: 'That refers to something that no longer exists.' }, 409);
      if (code === '22P02' || code === '23514') return json({ error: 'One of the values was not valid.' }, 400);
      console.error('Unhandled function error', e);
      // Only a short code is returned (never the message or query), so failures can be diagnosed
      // from the screen. 42P01 = a table is missing, 28P01/08006 = database connection problems.
      // Errors without a database code (setup or connection problems) also include their own short
      // text, cut to 160 characters. Database errors never include their text, since it can quote queries.
      const name = e instanceof Error ? e.name : 'Error';
      // Postgres's own message (for example: relation "projects" does not exist) is short and safe;
      // the wrapper's message quotes the whole query, so it is only used when there is no inner error.
      const inner = wrapped?.cause?.message;
      const raw = inner ?? (e instanceof Error ? e.message : '');
      const text = raw.replace(/\s+/g, ' ').slice(0, 160);
      const tag = code ? `code ${code}${inner ? `: ${text}` : ''}` : text ? `${name}: ${text}` : name;
      return json({ error: `Something went wrong on our side (${tag}). Please try again.` }, 500);
    }
  };
}

export const methodNotAllowed = () => new HttpError(405, 'That action is not supported.');
export const notFound = (what = 'That') => new HttpError(404, `${what} was not found.`);
