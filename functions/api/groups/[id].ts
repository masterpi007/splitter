import type { AuthEnv } from '../types/auth';
import { requireGroupAdmin } from '../utils/session';
import { getExpenses } from '../utils/groups';
import { removeMembership } from '../utils/users';
import { listGroupInvites, deleteInvite } from '../utils/invites';
import { calculateBalances, isBalanceClear, unacceptedCountFor } from '../utils/balances';


// DELETE /api/groups/:id — admin deletes the entire group.
// Removes: group record, expenses, invites, all user memberships.
export const onRequestDelete: PagesFunction<AuthEnv> = async (context) => {
  try {
    const groupId = context.params.id as string;
    if (!groupId) {
      return Response.json({ success: false, error: 'Group ID required' }, { status: 400 });
    }

    const ctx = await requireGroupAdmin(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const { group } = ctx;

    if (group.id !== groupId) {
      return Response.json({ success: false, error: 'Group ID mismatch' }, { status: 400 });
    }

    const env = context.env;

    // Refuse to delete a group that has any outstanding or pending balances.
    const expenses = await getExpenses(env, groupId);
    const balances = calculateBalances(expenses, group.members);
    const dirty = balances.filter(
      (b) => !isBalanceClear(b) || unacceptedCountFor(expenses as [], b.memberId) > 0,
    );
    if (dirty.length > 0) {
      const names = dirty
        .map((b) => group.members.find((m) => m.id === b.memberId)?.name ?? b.memberId)
        .join(', ');
      return Response.json(
        {
          success: false,
          error: `Cannot delete group: ${dirty.length} member(s) have unsettled balances or unaccepted transactions (${names}). Settle and accept everything first.`,
        },
        { status: 400 }
      );
    }

    // 1. Delete all invites for this group
    const invites = await listGroupInvites(env, groupId);
    await Promise.all(invites.map((inv) => deleteInvite(env, inv.code)));

    // 2. Remove memberships from all users in this group
    const userIds = group.members
      .map((m) => m.userId)
      .filter((uid): uid is string => !!uid);
    await Promise.all(userIds.map((uid) => removeMembership(env, uid, groupId)));

    // 3. One delete: members, expenses (with their splits, items, tags and
    // history) and invites all cascade from the group row. No index to
    // maintain either — listGroupIds is a query now.
    await env.DB.prepare(`DELETE FROM groups WHERE id = ?`).bind(groupId).run();

    return Response.json({ success: true, data: { deleted: true } });
  } catch (error) {
    console.error('Delete group error:', error);
    return Response.json({ success: false, error: 'Failed to delete group' }, { status: 500 });
  }
};
