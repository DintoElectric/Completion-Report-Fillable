import { getUser } from '@netlify/identity';
import type { Role } from '../../../shared/types.ts';
import { HttpError } from './http.ts';

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2 };

export interface Actor {
  id: string;
  email: string;
  name: string;
  role: Role;
}

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Highest known role wins. ADMIN_EMAILS makes an admin; an Identity role can too. A signed-in user with no role is a member. */
export function resolveRole(email: string | undefined, roles: unknown): Role {
  if (email && adminEmails().includes(email.toLowerCase())) return 'admin';
  const list = Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
  if (list.includes('admin')) return 'admin';
  if (list.includes('member')) return 'member';
  if (list.includes('viewer')) return 'viewer';
  return 'member';
}

export async function requireUser(): Promise<Actor> {
  const user = await getUser();
  if (!user) throw new HttpError(401, 'Your session has ended. Please sign in again.');
  const email = user.email ?? '';
  return {
    id: user.id,
    email,
    name: (user.name && user.name.trim()) || email || 'Unknown user',
    role: resolveRole(email, user.roles),
  };
}

export async function requireRole(min: Role): Promise<Actor> {
  const actor = await requireUser();
  if (RANK[actor.role] < RANK[min]) {
    throw new HttpError(403, `Your account (${actor.role}) can't do that. Ask an admin if you need access.`);
  }
  return actor;
}

export const atLeast = (a: Actor, min: Role) => RANK[a.role] >= RANK[min];
