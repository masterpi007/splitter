import type { AuthEnv } from '../types/auth';
import { requireGroupAdmin } from '../utils/session';

// GET /api/groups/friends — candidates for direct-add.
//
// Returns users who share any group with the caller (and aren't already in the
// active target group). The "shared group" gate prevents a fresh user from
// being enumerated or added without the admin having any prior connection to
// them — friendship is implicit, established by common group membership.
//
// Admin-only because only admins call the companion POST /api/groups/members
// endpoint that consumes this list.
export const onRequestGet: PagesFunction<AuthEnv> = async (context) => {
  try {
    const ctx = await requireGroupAdmin(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const { session, group: target } = ctx;

    // userIds that should NOT appear (already in target group, or the caller).
    const excluded = new Set<string>();
    excluded.add(session.userId);
    for (const m of target.members) if (m.userId) excluded.add(m.userId);

    interface Candidate {
      userId: string;
      name: string;
      groupNames: string[];
    }
    const map = new Map<string, Candidate>();

    // Every active member of every OTHER group the caller belongs to, in a
    // single query — the previous parallel getGroup-per-membership opened N
    // concurrent D1 batches in one invocation and could stall the request.
    const res = await context.env.DB.prepare(
      `SELECT g.name AS group_name, m.user_id, m.name
         FROM members me
         JOIN groups g ON g.id = me.group_id
         JOIN members m ON m.group_id = g.id AND m.removed_at IS NULL
        WHERE me.user_id = ? AND me.removed_at IS NULL AND me.group_id <> ?`,
    )
      .bind(session.userId, target.id)
      .all<{ group_name: string; user_id: string | null; name: string }>();

    for (const row of res.results ?? []) {
      if (!row.user_id || excluded.has(row.user_id)) continue;
      const existing = map.get(row.user_id);
      if (existing) {
        existing.groupNames.push(row.group_name);
      } else {
        map.set(row.user_id, {
          userId: row.user_id,
          name: row.name,
          groupNames: [row.group_name],
        });
      }
    }

    const data = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    return Response.json({ success: true, data });
  } catch (error) {
    console.error('List friends error:', error);
    return Response.json(
      { success: false, error: 'Failed to list friends' },
      { status: 500 }
    );
  }
};
