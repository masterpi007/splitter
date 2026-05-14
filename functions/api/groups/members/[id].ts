import type { AuthEnv } from '../../types/auth';
import { requireGroup, requireGroupAdmin } from '../../utils/session';
import { softRemoveMember, findMember, saveGroup, getExpenses } from '../../utils/groups';
import { removeMembership } from '../../utils/users';
import { calculateBalances, isBalanceClear } from '../../utils/balances';

// PATCH /api/groups/members/:id — admin edits per-member settings.
// Currently only share (the "Split" weight). Passing null/undefined or 0
// clears the override back to the implicit default of 1 (matching the
// GroupMember.share type comment). Negative, non-finite, or absurdly large
// values are rejected — shares are weights only, so we cap at 1e6 to keep
// the downstream distribution math in a sane range.
const SHARE_MAX = 1_000_000;

export const onRequestPatch: PagesFunction<AuthEnv> = async (context) => {
  try {
    const ctx = await requireGroupAdmin(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const { group } = ctx;
    const memberId = context.params.id as string;

    const target = findMember(group, memberId);
    if (!target || target.removedAt) {
      return Response.json({ success: false, error: 'Member not found' }, { status: 404 });
    }

    const body = await context.request.json() as { share?: number | null };

    let nextShare = target.share;
    if ('share' in body) {
      const raw = body.share;
      if (raw === null || raw === undefined || raw === 0) {
        nextShare = undefined;
      } else if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > SHARE_MAX) {
        return Response.json(
          { success: false, error: `share must be between 0 and ${SHARE_MAX}` },
          { status: 400 }
        );
      } else {
        nextShare = raw;
      }
    }

    const updatedMembers = group.members.map((m) =>
      m.id === memberId ? { ...m, share: nextShare } : m
    );
    const updated = { ...group, members: updatedMembers };
    await saveGroup(context.env, updated);
    return Response.json({ success: true, data: updated });
  } catch (error) {
    console.error('Update member error:', error);
    return Response.json(
      { success: false, error: 'Failed to update member' },
      { status: 500 }
    );
  }
};

// DELETE /api/groups/members/:id
// Admins can remove anyone; any member can remove themselves (leave the group).
// Soft-remove: entry moves to removedMembers so existing expenses still resolve
// names. Cannot remove the last admin.
// Blocked if the member has any outstanding or pending balance.
export const onRequestDelete: PagesFunction<AuthEnv> = async (context) => {
  try {
    const ctx = await requireGroup(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const { group, member: caller } = ctx;
    const memberId = context.params.id as string;

    const isSelf = memberId === caller.id;
    const isCallerAdmin = group.admins.includes(caller.id);
    if (!isSelf && !isCallerAdmin) {
      return Response.json(
        { success: false, error: 'Only admins can remove other members' },
        { status: 403 }
      );
    }

    const target = findMember(group, memberId);
    if (!target || target.removedAt) {
      return Response.json({ success: false, error: 'Member not found' }, { status: 404 });
    }

    const wasAdmin = group.admins.includes(memberId);
    if (wasAdmin && group.admins.length <= 1) {
      return Response.json(
        { success: false, error: 'Cannot remove the last admin — promote someone else first' },
        { status: 400 }
      );
    }

    // Block removal if the member has outstanding or pending balance.
    const expenses = await getExpenses(context.env, group.id);
    const balances = calculateBalances(expenses, group.members);
    const memberBalance = balances.find((b) => b.memberId === memberId);
    if (memberBalance && !isBalanceClear(memberBalance)) {
      const detail = memberBalance.pendingBalance !== 0
        ? 'They have pending transactions that must be settled first.'
        : 'They have an outstanding balance that must be settled first.';
      return Response.json(
        { success: false, error: `Cannot remove member: ${detail}` },
        { status: 400 }
      );
    }

    const updated = await softRemoveMember(context.env, group, memberId);

    if (target.userId) {
      await removeMembership(context.env, target.userId, group.id);
    }

    return Response.json({ success: true, data: updated });
  } catch (error) {
    console.error('Remove member error:', error);
    return Response.json(
      { success: false, error: 'Failed to remove member' },
      { status: 500 }
    );
  }
};
