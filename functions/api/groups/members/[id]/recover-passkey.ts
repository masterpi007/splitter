import type { AuthEnv } from '../../../types/auth';
import { KV_KEYS } from '../../../types/auth';
import {
  requireSession,
  extractGroupId,
  forbidden,
  badRequest,
  notFound,
} from '../../../utils/session';
import { getGroup, findMember, isAdmin } from '../../../utils/groups';
import { getUser, isUserMemberOfGroup } from '../../../utils/users';
import { isAppAdmin } from '../../../utils/admin';
import { createPasskeyInvite } from '../../../utils/passkeyInvite';

// Recovery links are handed to the member out-of-band (chat, email), so they
// need to outlive the 10-minute self-serve window. Seven days balances
// "enough time to act" against "not a long-lived credential-granting URL".
const RECOVERY_TTL_SECONDS = 7 * 24 * 60 * 60;

// POST /api/groups/members/:id/recover-passkey
//
// Issue a passkey-recovery link for a member who lost access to their
// passkey(s). The link (an /invite/:code passkey invite bound to the member's
// existing identity) lets them register a fresh passkey WITHOUT losing their
// membership or expense history.
//
// Authorized for: an admin of the target member's group, OR an app admin
// (APP_ADMIN_USER_IDS) acting on any group. By default the member's existing
// passkeys are revoked first (the "lost my only device" case); pass
// { revokeExisting: false } to merely add a device instead.
export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const { env, request } = context;

    const authed = await requireSession(env, request);
    if (authed instanceof Response) return authed;

    const groupId = extractGroupId(request);
    if (!groupId) return badRequest('Missing X-Group-Id');

    const group = await getGroup(env, groupId);
    if (!group) return notFound('Group not found');

    const targetMemberId = context.params.id as string;
    const target = findMember(group, targetMemberId);
    if (!target || target.removedAt) {
      return notFound('Member not found');
    }

    // Authorize: app admins may act on any group; otherwise the caller must be
    // an active admin of THIS group.
    const appAdmin = isAppAdmin(env, authed.session.userId);
    let groupAdmin = false;
    if (!appAdmin) {
      const membership = await isUserMemberOfGroup(env, authed.session.userId, groupId);
      const callerMember = membership ? findMember(group, membership.memberId) : undefined;
      groupAdmin = !!callerMember && !callerMember.removedAt && isAdmin(group, callerMember.id);
    }
    if (!appAdmin && !groupAdmin) {
      return forbidden('Admin access required');
    }

    // Only claimed members (linked to a global identity) have passkeys to
    // recover. An unclaimed placeholder should join via a group invite instead.
    if (!target.userId) {
      return badRequest(
        "This member hasn't registered a passkey yet — send them a group invite link instead.",
      );
    }

    const body = (await request.json().catch(() => ({}))) as { revokeExisting?: boolean };
    const revokeExisting = body.revokeExisting !== false; // default true

    if (revokeExisting) {
      // Drop every existing credential so the lost passkey can no longer sign
      // in. The recovery link below re-populates the record with a fresh one.
      await env.SPLITTER_KV.delete(KV_KEYS.credentials(target.userId));
    }

    // Prefer the member's global identity name (what the /invite page and the
    // resulting session display); fall back to the per-group display name.
    const user = await getUser(env, target.userId);
    const userName = user?.name || target.name;

    const origin = env.RP_ORIGIN || new URL(request.url).origin;
    const invite = await createPasskeyInvite(env, {
      userId: target.userId,
      userName,
      origin,
      ttlSeconds: RECOVERY_TTL_SECONDS,
    });

    return Response.json({
      success: true,
      data: {
        ...invite,
        memberName: target.name,
        revokedExisting: revokeExisting,
      },
    });
  } catch (error) {
    console.error('Recover passkey error:', error);
    return Response.json(
      { success: false, error: 'Failed to create recovery link' },
      { status: 500 }
    );
  }
};
