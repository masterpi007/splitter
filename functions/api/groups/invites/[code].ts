import type { AuthEnv } from '../../types/auth';
import { requireSession, requireGroupAdmin } from '../../utils/session';
import { getInvite, deleteInvite } from '../../utils/invites';
import { getGroup, saveGroup, GroupMember } from '../../utils/groups';
import { addMembership, isUserMemberOfGroup } from '../../utils/users';
import { acquireLock } from '../../utils/locks';

// GET /api/groups/invites/:code — preview an invite (used by the accept-invite
// landing page). Does not require a session, since the visitor may not be
// logged in yet. Returns minimal group info for the UI.
export const onRequestGet: PagesFunction<AuthEnv> = async (context) => {
  try {
    const code = context.params.code as string;
    const invite = await getInvite(context.env, code);
    if (!invite) {
      return Response.json({ success: false, error: 'Invite not found' }, { status: 404 });
    }
    const group = await getGroup(context.env, invite.groupId);
    if (!group) {
      return Response.json({ success: false, error: 'Group not found' }, { status: 404 });
    }
    return Response.json({
      success: true,
      data: {
        code: invite.code,
        groupId: group.id,
        groupName: group.name,
        memberCount: group.members.length,
      },
    });
  } catch (error) {
    return Response.json(
      { success: false, error: 'Failed to load invite' },
      { status: 500 }
    );
  }
};

// POST /api/groups/invites/:code — accept the invite as the currently signed-in
// user. Creates the member row and membership, idempotent if already a member.
// Brand-new users should instead register via /api/auth/register/verify with
// groupId set (that flow mints the User and calls into the group directly).
export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const authed = await requireSession(context.env, context.request);
    if (authed instanceof Response) return authed;

    const code = context.params.code as string;
    const invite = await getInvite(context.env, code);
    if (!invite) {
      return Response.json({ success: false, error: 'Invite not found' }, { status: 404 });
    }

    // Serialize concurrent accepts by the same user on the same group
    // (double-click, cross-tab, retry storm). Without this the idempotency
    // check + read-modify-write below can duplicate member rows. The lock
    // also narrows the window in which two different users race to claim
    // the same placeholder.
    const lock = await acquireLock(
      context.env,
      `invite-accept::${invite.groupId}::${authed.session.userId}`,
    );
    if (!lock) {
      return Response.json(
        { success: false, error: 'Another accept is in progress, please retry' },
        { status: 409 },
      );
    }

    try {
      // Re-check membership under the lock — a sibling request may have
      // landed in the tiny window between getInvite and acquireLock.
      const existing = await isUserMemberOfGroup(
        context.env,
        authed.session.userId,
        invite.groupId,
      );
      if (existing) {
        return Response.json({
          success: true,
          data: { groupId: invite.groupId, memberId: existing.memberId, alreadyMember: true },
        });
      }

      const group = await getGroup(context.env, invite.groupId);
      if (!group) {
        return Response.json({ success: false, error: 'Group not found' }, { status: 404 });
      }

      const body = (await context.request.json().catch(() => ({}))) as { displayName?: string };
      const displayName = (body.displayName?.trim() || authed.session.userName);

      const now = new Date().toISOString();

      // If an admin pre-seeded a placeholder (member row with no userId) that
      // matches the caller's display name, claim it in place. Otherwise the
      // accept would create a duplicate row and the placeholder's existing
      // expense attributions would never resolve to the real user.
      const normalized = displayName.trim().toLowerCase();
      const placeholderIdx = group.members.findIndex(
        (m) => !m.userId && m.name.trim().toLowerCase() === normalized,
      );

      let memberId: string;
      let memberName: string;

      if (placeholderIdx !== -1) {
        const placeholder = group.members[placeholderIdx];
        memberId = placeholder.id;
        memberName = placeholder.name; // preserve admin-picked spelling/casing
        group.members[placeholderIdx] = {
          ...placeholder,
          userId: authed.session.userId,
          joinedAt: placeholder.joinedAt ?? now,
        };
      } else {
        // No matching placeholder — insert a fresh row, disambiguating the
        // display name against all existing members.
        let uniqueName = displayName;
        const taken = new Set(group.members.map((m) => m.name.toLowerCase()));
        let suffix = 2;
        while (taken.has(uniqueName.toLowerCase())) {
          uniqueName = `${displayName} ${suffix++}`;
        }
        const newMember: GroupMember = {
          id: crypto.randomUUID(),
          userId: authed.session.userId,
          name: uniqueName,
          joinedAt: now,
        };
        group.members.push(newMember);
        memberId = newMember.id;
        memberName = newMember.name;
      }

      // Write membership first so a crashed partial write leaves state that
      // /api/groups can recover by filtering out the stale membership row on
      // the next read; the reverse order would make the user invisible to
      // themselves while still consuming a placeholder slot.
      await addMembership(context.env, authed.session.userId, {
        groupId: group.id,
        memberId,
        joinedAt: now,
      });
      await saveGroup(context.env, group);

      return Response.json({
        success: true,
        data: { groupId: group.id, memberId, memberName, alreadyMember: false },
      });
    } finally {
      await lock.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Accept invite error:', message, error);
    return Response.json(
      { success: false, error: `Failed to accept invite: ${message}` },
      { status: 500 }
    );
  }
};

// DELETE /api/groups/invites/:code — admin revokes an invite.
// The target group is implicit in the invite record, but we still require the
// caller to assert X-Group-Id matches (prevents cross-group revocation by
// passing around codes from other groups).
export const onRequestDelete: PagesFunction<AuthEnv> = async (context) => {
  try {
    const ctx = await requireGroupAdmin(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const code = context.params.code as string;
    const invite = await getInvite(context.env, code);
    if (!invite) return Response.json({ success: true });
    if (invite.groupId !== ctx.group.id) {
      return Response.json({ success: false, error: 'Invite does not belong to this group' }, { status: 403 });
    }
    await deleteInvite(context.env, code);
    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      { success: false, error: 'Failed to delete invite' },
      { status: 500 }
    );
  }
};
