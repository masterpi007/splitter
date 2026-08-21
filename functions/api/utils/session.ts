// Shared session/authorization helpers used by every API handler.
// Encapsulates: "is the caller authenticated?" and "is the caller a member
// of the group they're acting on?" so route files don't re-implement these.

import type { AuthEnv, Session } from '../types/auth';
import { getTokenFromCookies, verifySession, verifyToken, deleteSession } from './jwt';
import { buildGroupRecord, GroupRecord, GroupMember, findMember, isAdmin } from './groups';
import type { UserMembership } from './users';
import type { MemberRow } from './db';

export interface AuthedContext {
  session: Session;
}

export interface GroupContext extends AuthedContext {
  group: GroupRecord;
  member: GroupMember; // the caller's member row in this group
  membership: UserMembership;
}

// Return a 401 JSON response.
function unauthorized(message = 'Not authenticated'): Response {
  return Response.json({ success: false, error: message }, { status: 401 });
}

function forbidden(message = 'Forbidden'): Response {
  return Response.json({ success: false, error: message }, { status: 403 });
}

function badRequest(message: string): Response {
  return Response.json({ success: false, error: message }, { status: 400 });
}

function notFound(message = 'Not found'): Response {
  return Response.json({ success: false, error: message }, { status: 404 });
}

// Require an authenticated session. Returns the session on success, or a
// Response on failure that the handler should return directly.
export async function requireSession(
  env: AuthEnv,
  request: Request,
): Promise<AuthedContext | Response> {
  const token = getTokenFromCookies(request);
  if (!token) return unauthorized();
  const session = await verifySession(env, token);
  if (!session) return unauthorized('Session expired');
  return { session };
}

// Extract the target groupId from the request: X-Group-Id header first,
// else ?groupId= query param. Returns null if neither is present.
export function extractGroupId(request: Request): string | null {
  const header = request.headers.get('X-Group-Id');
  if (header) return header;
  const url = new URL(request.url);
  return url.searchParams.get('groupId');
}

// Require an authenticated session AND that the caller is an active member of
// the group identified by X-Group-Id / ?groupId=. Returns a full group context
// on success or a Response on failure.
export async function requireGroup(
  env: AuthEnv,
  request: Request,
): Promise<GroupContext | Response> {
  const token = getTokenFromCookies(request);
  if (!token) return unauthorized();
  // Signature check is pure CPU; the payload's sessionId/userId then let the
  // session, membership and group lookups share ONE D1 round trip instead of
  // three sequential ones — the dominant cost when D1 sits far from the edge.
  const payload = await verifyToken(env, token);
  if (!payload) return unauthorized('Session expired');

  const groupId = extractGroupId(request);
  if (!groupId) return badRequest('Missing X-Group-Id');

  const [sessionRes, membershipRes, groupRes, memberRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, user_id, user_name, created_at, expires_at FROM sessions WHERE id = ?`,
    ).bind(payload.sessionId),
    env.DB.prepare(
      `SELECT group_id, id AS member_id, joined_at
         FROM members
        WHERE user_id = ? AND group_id = ? AND removed_at IS NULL`,
    ).bind(payload.userId, groupId),
    env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId),
    env.DB.prepare(`SELECT * FROM members WHERE group_id = ? ORDER BY joined_at`).bind(groupId),
  ]);

  const s = sessionRes.results?.[0] as
    | { id: string; user_id: string; user_name: string; created_at: string; expires_at: string }
    | undefined;
  // The session row is the revocation authority: it must exist, be unexpired,
  // and belong to the user the JWT claims.
  if (!s || s.user_id !== payload.userId) return unauthorized('Session expired');
  if (new Date(s.expires_at) < new Date()) {
    await deleteSession(env, s.id);
    return unauthorized('Session expired');
  }
  const session: Session = {
    sessionId: s.id,
    userId: s.user_id,
    userName: s.user_name,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
  };

  const m = membershipRes.results?.[0] as
    | { group_id: string; member_id: string; joined_at: string | null }
    | undefined;
  if (!m) return forbidden('Not a member of this group');
  const membership: UserMembership = {
    groupId: m.group_id,
    memberId: m.member_id,
    joinedAt: m.joined_at ?? '',
  };

  const g = groupRes.results?.[0] as
    | { id: string; name: string; currency: string; created_at: string }
    | undefined;
  if (!g) return notFound('Group not found');
  const group = buildGroupRecord(g, memberRes.results as unknown as MemberRow[]);

  const member = findMember(group, membership.memberId);
  if (!member || member.removedAt) {
    // Caller was removed from the group; their membership index is stale.
    return forbidden('Access to this group has been revoked');
  }

  return { session, group, member, membership };
}

// Require that the caller is an admin of their group context.
export async function requireGroupAdmin(
  env: AuthEnv,
  request: Request,
): Promise<GroupContext | Response> {
  const ctx = await requireGroup(env, request);
  if (ctx instanceof Response) return ctx;
  if (!isAdmin(ctx.group, ctx.member.id)) return forbidden('Admin access required');
  return ctx;
}

export { unauthorized, forbidden, badRequest, notFound };
