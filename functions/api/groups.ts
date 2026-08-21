import type { AuthEnv } from './types/auth';
import { getTokenFromCookies, verifyToken } from './utils/jwt';
import { requireSession } from './utils/session';
import { addMembership } from './utils/users';
import { createGroup, GroupMember } from './utils/groups';

// GET /api/groups — list the caller's groups (id, name, memberCount).
//
// One D1 round trip for the whole endpoint. The previous shape — session
// lookup, then the membership index, then a parallel getGroup per membership —
// opened N concurrent batches in a single invocation; under load those
// connections could stall until the edge cut the request off with a 524.
// The members table is queried directly by user_id, so it is authoritative:
// removed members simply don't match, no post-filtering needed.
export const onRequestGet: PagesFunction<AuthEnv> = async (context) => {
  try {
    const env = context.env;
    const token = getTokenFromCookies(context.request);
    if (!token) {
      return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }
    const payload = await verifyToken(env, token);
    if (!payload) {
      return Response.json({ success: false, error: 'Session expired' }, { status: 401 });
    }

    const [sessionRes, groupsRes] = await env.DB.batch([
      env.DB.prepare(
        `SELECT id, user_id, expires_at FROM sessions WHERE id = ?`,
      ).bind(payload.sessionId),
      env.DB.prepare(
        `SELECT g.id, g.name, me.id AS member_id, me.is_admin,
                (SELECT COUNT(*) FROM members m2
                  WHERE m2.group_id = g.id AND m2.removed_at IS NULL) AS member_count
           FROM members me
           JOIN groups g ON g.id = me.group_id
          WHERE me.user_id = ? AND me.removed_at IS NULL
          ORDER BY me.joined_at`,
      ).bind(payload.userId),
    ]);

    const s = sessionRes.results?.[0] as
      | { id: string; user_id: string; expires_at: string }
      | undefined;
    if (!s || s.user_id !== payload.userId || new Date(s.expires_at) < new Date()) {
      return Response.json({ success: false, error: 'Session expired' }, { status: 401 });
    }

    const rows = (groupsRes.results ?? []) as unknown as {
      id: string; name: string; member_id: string; is_admin: number; member_count: number;
    }[];
    const data = rows.map((r) => ({
      id: r.id,
      name: r.name,
      memberId: r.member_id,
      memberCount: r.member_count,
      isAdmin: r.is_admin === 1,
    }));

    return Response.json({ success: true, data });
  } catch (error) {
    return Response.json(
      { success: false, error: 'Failed to list groups' },
      { status: 500 }
    );
  }
};

// POST /api/groups — create a new group. Caller becomes the first member
// (and the sole admin) of the new group.
export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const authed = await requireSession(context.env, context.request);
    if (authed instanceof Response) return authed;

    const { name, currency, displayName } = await context.request.json() as {
      name?: string;
      currency?: string;
      displayName?: string;
    };
    if (!name || !name.trim()) {
      return Response.json({ success: false, error: 'Group name is required' }, { status: 400 });
    }

    const memberId = crypto.randomUUID();
    const creator: GroupMember = {
      id: memberId,
      userId: authed.session.userId,
      name: (displayName?.trim() || authed.session.userName),
      joinedAt: new Date().toISOString(),
    };

    const group = await createGroup(context.env, {
      name: name.trim(),
      currency: (currency ?? 'K').trim() || 'K',
      creator,
    });

    await addMembership(context.env, authed.session.userId, {
      groupId: group.id,
      memberId,
      joinedAt: creator.joinedAt!,
    });

    return Response.json({ success: true, data: group });
  } catch (error) {
    console.error('Create group error:', error);
    return Response.json(
      { success: false, error: 'Failed to create group' },
      { status: 500 }
    );
  }
};
