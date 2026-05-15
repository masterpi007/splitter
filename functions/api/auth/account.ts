import type { AuthEnv } from '../types/auth';
import { KV_KEYS } from '../types/auth';
import { requireSession } from '../utils/session';
import { getTokenFromCookies, verifyToken, deleteSession, clearAuthCookie } from '../utils/jwt';
import { getMemberships, removeMembership } from '../utils/users';
import { getGroup, softRemoveMember, getExpenses } from '../utils/groups';
import { calculateBalances, isBalanceClear } from '../utils/balances';

// DELETE /api/auth/account — permanently delete the caller's account.
// For each group the user belongs to the member row is soft-removed so
// expense history stays intact. Credentials, memberships, user record, and
// the current session are then wiped. Blocked if the user has any unsettled
// balance in any group.
export const onRequestDelete: PagesFunction<AuthEnv> = async (context) => {
  try {
    const authed = await requireSession(context.env, context.request);
    if (authed instanceof Response) return authed;
    const { session } = authed;
    const { userId } = session;
    const env = context.env;

    // Check balances across all groups before touching anything.
    const memberships = await getMemberships(env, userId);
    const unclean: string[] = [];
    for (const m of memberships) {
      const group = await getGroup(env, m.groupId);
      if (!group) continue;
      const expenses = await getExpenses(env, m.groupId);
      const balances = calculateBalances(expenses, group.members);
      const mine = balances.find((b) => b.memberId === m.memberId);
      if (mine && !isBalanceClear(mine)) {
        unclean.push(group.name);
      }
    }
    if (unclean.length > 0) {
      return Response.json(
        {
          success: false,
          error: `Cannot delete account: you have unsettled balances in ${unclean.join(', ')}. Settle all balances first.`,
        },
        { status: 400 }
      );
    }

    // Soft-remove from every group (preserves expense attribution).
    for (const m of memberships) {
      const group = await getGroup(env, m.groupId);
      if (!group) continue;
      const member = group.members.find((gm) => gm.id === m.memberId);
      if (!member || member.removedAt) continue;
      await softRemoveMember(env, group, m.memberId);
    }

    // Wipe user data.
    await Promise.all([
      env.SPLITTER_KV.delete(`user::${userId}`),
      env.SPLITTER_KV.delete(`user::${userId}::memberships`),
      env.SPLITTER_KV.delete(KV_KEYS.credentials(userId)),
    ]);

    // Invalidate the current session.
    const token = getTokenFromCookies(context.request);
    if (token) {
      const payload = await verifyToken(env, token);
      if (payload?.sessionId) {
        await deleteSession(env, payload.sessionId).catch(() => {});
      }
    }

    return new Response(
      JSON.stringify({ success: true, data: { deleted: true } }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': clearAuthCookie(),
        },
      }
    );
  } catch (error) {
    console.error('Delete account error:', error);
    return Response.json({ success: false, error: 'Failed to delete account' }, { status: 500 });
  }
};
