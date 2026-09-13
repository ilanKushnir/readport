import { type FastifyReply, type FastifyRequest } from 'fastify';
import { type Role } from '@readport/shared';
import { type DB } from '../db/index.js';

/**
 * Role checks. Roles are flat, not hierarchical by accident: an admin can do
 * everything a curator can, a curator everything a reader can.
 */
export const ROLE_RANK: Record<Role, number> = { reader: 0, curator: 1, admin: 2 };

export function hasRole(role: string | undefined, atLeast: Role): boolean {
  return (ROLE_RANK[role as Role] ?? -1) >= ROLE_RANK[atLeast];
}

/** Reply 403 unless the signed-in user holds at least `atLeast`. */
export function requireRole(req: FastifyRequest, reply: FastifyReply, atLeast: Role): boolean {
  if (!req.user || !hasRole(req.user.role, atLeast)) {
    void reply.code(403).send({ error: 'forbidden', detail: `Requires the ${atLeast} role` });
    return false;
  }
  return true;
}

/**
 * May this person take a copy of a book off the server?
 *
 * Read from the database on every request rather than carried in the session.
 * A capability that lets files leave the server is exactly the one an admin
 * expects to be able to revoke NOW - a session-cached copy would keep working
 * until the session happened to expire, which on a reading app is weeks.
 *
 * Admins always may, and are not stored as an exception.
 */
export function mayExport(db: DB, user: { id: string; role: string } | null): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const row = db.prepare('SELECT can_export FROM users WHERE id = ?').get(user.id) as
    { can_export: number } | undefined;
  return Number(row?.can_export) === 1;
}

/** Reply 403 unless this person may take a copy off the server. */
export function requireExport(db: DB, req: FastifyRequest, reply: FastifyReply): boolean {
  if (mayExport(db, req.user)) return true;
  void reply
    .code(403)
    .send({ error: 'forbidden', detail: 'Downloading the file is not enabled for this account' });
  return false;
}
