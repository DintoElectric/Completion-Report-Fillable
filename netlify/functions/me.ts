import type { Context } from '@netlify/functions';
import { requireUser } from './_lib/auth.ts';
import { handle, json } from './_lib/http.ts';
import { CHUNK_BYTES, maxFileBytes } from './_lib/limits.ts';
import type { Me } from '../../shared/types.ts';

export default handle(async (_req: Request, _ctx: Context) => {
  const a = await requireUser();
  const me: Me = { id: a.id, email: a.email, name: a.name, role: a.role, limits: { maxFileBytes: maxFileBytes(), chunkBytes: CHUNK_BYTES }, aiReady: !!process.env.ANTHROPIC_API_KEY };
  return json(me);
});
