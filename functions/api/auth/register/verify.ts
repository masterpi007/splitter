import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthEnv, RegisterVerifyRequest, StoredCredential } from '../../types/auth';
import { consumeChallenge } from '../../utils/challenges';
import { addCredential, getCredentials, findCredentialOwner } from '../../utils/credentials';
import { createSession, createAuthCookie } from '../../utils/jwt';
import {
  GroupMember,
  GroupRecord,
  getGroup,
  saveGroup,
} from '../../utils/groups';
import { createUser, addMembership } from '../../utils/users';
import { getInvite } from '../../utils/invites';

// Register a brand-new User and attach them to a group. Two target-group
// modes:
//   - no inviteCode: legacy '1matrix' group (memberId === userId invariant).
//     This is the MemberSelector "New User" flow.
//   - inviteCode: the invite's group. Registers the new User and joins them
//     to that group atomically, so a brand-new visitor arriving on an invite
//     link can create an account and become a member in one round trip.
// In both cases the caller-supplied `memberId` is treated as the User.id
// and as the WebAuthn userID (that's what /api/auth/register/options keys
// the challenge by). Accepting a client-supplied groupId would let an
// unauthenticated caller bind a passkey to an arbitrary member row in any
// group — the groupId is always derived from trusted state (legacy hard-
// code or server-stored invite record).
export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const { memberId, memberName, credential, friendlyName, inviteCode } =
      await context.request.json() as RegisterVerifyRequest & { inviteCode?: string };

    if (!memberId || !memberName || !credential) {
      return Response.json(
        { success: false, error: 'memberId, memberName, and credential are required' },
        { status: 400 }
      );
    }

    const env = context.env;
    const userId = memberId;

    // Resolve the target group from trusted state. If an invite code is
    // supplied, join that group atomically. If no invite code, register a
    // standalone User with no group — caller creates a group after sign-in.
    let targetGroupId: string | null = null;
    if (inviteCode) {
      const invite = await getInvite(env, inviteCode);
      if (!invite) {
        return Response.json(
          { success: false, error: 'Invite not found' },
          { status: 404 }
        );
      }
      targetGroupId = invite.groupId;
    }

    // Refuse to (re)register an identity that already has passkeys. Adding
    // another passkey to an existing account goes through the authenticated
    // /api/auth/passkeys/invite flow. Without this gate, any unauthenticated
    // caller who knows a legacy memberId (UUIDs are visible to every group
    // member) could append their own credential to the victim's account.
    // Allow registration if a User row exists but has no credentials yet
    // (placeholder/bootstrap case — the member row was created but never
    // claimed with a passkey).
    const existingCredentials = await getCredentials(env, userId);
    if (existingCredentials.length > 0) {
      return Response.json(
        { success: false, error: 'This member is already registered' },
        { status: 409 }
      );
    }

    // Get and consume the challenge (one-time use)
    const expectedChallenge = await consumeChallenge(env, memberId, 'registration');
    if (!expectedChallenge) {
      return Response.json(
        { success: false, error: 'Challenge expired or not found. Please try again.' },
        { status: 400 }
      );
    }

    const origin = env.RP_ORIGIN || new URL(context.request.url).origin;
    const rpID = env.RP_ID || 'localhost';

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return Response.json(
        { success: false, error: 'Registration verification failed' },
        { status: 400 }
      );
    }

    // Reject if this passkey already belongs to someone. The (existingUser
    // || existingCredentials) gate above is keyed by the client-supplied
    // userId — the invite flow mints a fresh UUID each call, so it will
    // never collide with an existing account. The authoritative dedupe is
    // by credential id (globally unique per authenticator), checked here
    // after WebAuthn verification so we never touch KV on unverified
    // claims. Without this, a returning user on an invite link would end
    // up with a second, duplicate User backed by the same physical
    // passkey.
    const credentialId = verification.registrationInfo.credential.id;
    const existingOwner = await findCredentialOwner(env, credentialId);
    if (existingOwner) {
      return Response.json(
        {
          success: false,
          error: 'This passkey is already registered. Sign in instead.',
          code: 'CREDENTIAL_EXISTS',
        },
        { status: 409 }
      );
    }

    // We refused above if a User or credentials already exist, so this is a
    // fresh registration.
    const user = await createUser(env, { id: userId, name: memberName });

    const now = new Date().toISOString();

    if (targetGroupId) {
      // Invite flow: attach the new user to the invited group.
      const group = await getGroup(env, targetGroupId);
      if (!group) {
        return Response.json(
          { success: false, error: `Group ${targetGroupId} not found` },
          { status: 404 }
        );
      }

      const { memberId: attachedMemberId, conflict } = attachToGroup(
        group,
        userId,
        memberName,
        { legacy: false, clientMemberId: memberId, now },
      );
      if (conflict) return conflict;

      await addMembership(env, userId, {
        groupId: targetGroupId,
        memberId: attachedMemberId,
        joinedAt: now,
      });
      await saveGroup(env, group);
    }

    const { registrationInfo } = verification;
    const storedCredential: StoredCredential = {
      id: credential.id,
      publicKey: registrationInfo.credential.publicKey,
      counter: registrationInfo.credential.counter,
      deviceType: registrationInfo.credentialDeviceType,
      backedUp: registrationInfo.credentialBackedUp,
      transports: credential.response.transports,
      createdAt: now,
      friendlyName: friendlyName || getDefaultFriendlyName(context.request),
    };
    await addCredential(env, userId, storedCredential);

    const { session, token } = await createSession(env, userId, user.name);

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          verified: true,
          session: {
            userId: session.userId,
            userName: session.userName,
            expiresAt: session.expiresAt,
          },
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': createAuthCookie(token),
        },
      }
    );
  } catch (error) {
    // Log the detailed error server-side; return a generic string so we
    // don't leak library internals (origin/RPID, CBOR decode failures, etc.)
    // that would help an attacker probe the deployment.
    console.error('[reg/verify] FULL ERROR:', error);
    return Response.json(
      { success: false, error: 'Failed to verify registration' },
      { status: 500 }
    );
  }
};

// Mutates `group.members` in place to attach `userId` as a member. Returns
// the memberId that was claimed/created, or a Response carrying an error
// the caller should surface.
//   legacy: the existing row with id === clientMemberId is claimed; if none
//     exists, insert one (first-member case).
//   invite: look for a placeholder (userId-less row) whose name matches the
//     display name; if found claim it in place, otherwise insert a fresh
//     row with a server-minted memberId and a unique name.
function attachToGroup(
  group: GroupRecord,
  userId: string,
  memberName: string,
  opts: { legacy: boolean; clientMemberId: string; now: string },
): { memberId: string; conflict?: Response } {
  const { legacy, clientMemberId, now } = opts;

  if (legacy) {
    const idx = group.members.findIndex((m) => m.id === clientMemberId);
    if (idx === -1) {
      const newMember: GroupMember = {
        id: clientMemberId,
        userId,
        name: memberName,
        joinedAt: now,
      };
      group.members.push(newMember);
      return { memberId: clientMemberId };
    }
    const existing = group.members[idx];
    // Refuse to rebind a member row that's already claimed by a different
    // user. In legacy this can't happen (userId === memberId invariant);
    // the check is defense-in-depth for stale/promoted data.
    if (existing.userId && existing.userId !== userId) {
      return {
        memberId: clientMemberId,
        conflict: Response.json(
          { success: false, error: 'Member is already claimed' },
          { status: 409 },
        ),
      };
    }
    group.members[idx] = {
      ...existing,
      userId,
      name: memberName,
      joinedAt: existing.joinedAt ?? now,
    };
    return { memberId: clientMemberId };
  }

  // Invite flow: claim placeholder by normalized name if one matches —
  // preserves admin-seeded attributions instead of creating a duplicate.
  const normalized = memberName.trim().toLowerCase();
  const placeholderIdx = group.members.findIndex(
    (m) => !m.userId && m.name.trim().toLowerCase() === normalized,
  );
  if (placeholderIdx !== -1) {
    const placeholder = group.members[placeholderIdx];
    group.members[placeholderIdx] = {
      ...placeholder,
      userId,
      joinedAt: placeholder.joinedAt ?? now,
    };
    return { memberId: placeholder.id };
  }

  // Disambiguate display name against existing members.
  let uniqueName = memberName;
  const taken = new Set(group.members.map((m) => m.name.toLowerCase()));
  let suffix = 2;
  while (taken.has(uniqueName.toLowerCase())) {
    uniqueName = `${memberName} ${suffix++}`;
  }
  const newMember: GroupMember = {
    id: crypto.randomUUID(),
    userId,
    name: uniqueName,
    joinedAt: now,
  };
  group.members.push(newMember);
  return { memberId: newMember.id };
}

function getDefaultFriendlyName(request: Request): string {
  const userAgent = request.headers.get('User-Agent') || '';
  if (userAgent.includes('iPhone')) return 'iPhone';
  if (userAgent.includes('iPad')) return 'iPad';
  if (userAgent.includes('Mac')) return 'Mac';
  if (userAgent.includes('Android')) return 'Android';
  if (userAgent.includes('Windows')) return 'Windows';
  if (userAgent.includes('Linux')) return 'Linux';
  return 'Passkey';
}
