import type { AuthEnv } from '../types/auth';
import { requireGroupAdmin } from '../utils/session';
import { LEGACY_GROUP_ID, getExpenses } from '../utils/groups';
import { removeMembership } from '../utils/users';
import { listGroupInvites, deleteInvite } from '../utils/invites';
import { calculateBalances, isBalanceClear } from '../utils/balances';

// Legacy group uses bare keys; all others use namespaced keys.
function groupKvKey(groupId: string) {
  return groupId === LEGACY_GROUP_ID ? 'group' : `group::${groupId}`;
}
function expensesKvKey(groupId: string) {
  return groupId === LEGACY_GROUP_ID ? 'expenses' : `expenses::${groupId}`;
}

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
    const dirty = balances.filter((b) => !isBalanceClear(b));
    if (dirty.length > 0) {
      const names = dirty
        .map((b) => group.members.find((m) => m.id === b.memberId)?.name ?? b.memberId)
        .join(', ');
      return Response.json(
        {
          success: false,
          error: `Cannot delete group: ${dirty.length} member(s) have unsettled balances (${names}). Settle all balances first.`,
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

    // 3. Delete group record and expenses (use correct keys for legacy group)
    await Promise.all([
      env.SPLITTER_KV.delete(groupKvKey(groupId)),
      env.SPLITTER_KV.delete(expensesKvKey(groupId)),
      env.SPLITTER_KV.delete(`group-invites::${groupId}`),
    ]);

    // 4. Remove from group index (legacy group not in index but harmless)
    const GROUP_INDEX_KEY = 'group-index';
    const index = (await env.SPLITTER_KV.get<string[]>(GROUP_INDEX_KEY, 'json')) ?? [];
    const filtered = index.filter((id) => id !== groupId);
    if (filtered.length !== index.length) {
      await env.SPLITTER_KV.put(GROUP_INDEX_KEY, JSON.stringify(filtered));
    }

    return Response.json({ success: true, data: { deleted: true } });
  } catch (error) {
    console.error('Delete group error:', error);
    return Response.json({ success: false, error: 'Failed to delete group' }, { status: 500 });
  }
};
