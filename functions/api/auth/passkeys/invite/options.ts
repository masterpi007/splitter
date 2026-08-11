import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { AuthEnv, PasskeyInvite, StoredChallenge } from '../../../types/auth';
import { KV_KEYS, CHALLENGE_TTL_SECONDS } from '../../../types/auth';
import { getCredentials } from '../../../utils/credentials';
import { getRp } from '../../../utils/rp';
import { getEphemeral, deleteEphemeral, putEphemeral } from '../../../utils/db';

interface InviteOptionsRequest {
  inviteCode: string;
}

// POST /api/auth/passkeys/invite/options - Get registration options using an invite code
export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const { inviteCode } = await context.request.json() as InviteOptionsRequest;

    if (!inviteCode) {
      return Response.json(
        { success: false, error: 'inviteCode is required' },
        { status: 400 }
      );
    }

    const env = context.env;

    // Get and validate the invite
    const invite = await getEphemeral<PasskeyInvite>(env, KV_KEYS.invite(inviteCode));

    if (!invite) {
      return Response.json(
        { success: false, error: 'Invalid or expired invite code' },
        { status: 400 }
      );
    }

    // Check if invite has expired
    if (new Date(invite.expiresAt) < new Date()) {
      await deleteEphemeral(env, KV_KEYS.invite(inviteCode));
      return Response.json(
        { success: false, error: 'Invite code has expired' },
        { status: 400 }
      );
    }

    const { userId, userName } = invite;

    const existingCredentials = await getCredentials(env, userId);

    const { rpID, rpName } = getRp(context.request, env);
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName,
      userID: new TextEncoder().encode(userId),
      userDisplayName: userName,
      attestationType: 'none',
      excludeCredentials: existingCredentials.map(cred => ({
        id: cred.id,
        transports: cred.transports,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
    });

    // Store challenge associated with the invite code (not memberId)
    const now = Date.now();
    const storedChallenge: StoredChallenge = {
      challenge: options.challenge,
      type: 'registration',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    };

    await putEphemeral(env, KV_KEYS.inviteChallenge(inviteCode), 'challenge', storedChallenge, CHALLENGE_TTL_SECONDS);

    return Response.json({
      success: true,
      data: {
        options,
        userName, // Let the new device know whose account this is
      },
    });
  } catch (error) {
    console.error('Invite options error:', error);
    return Response.json(
      { success: false, error: 'Failed to generate registration options' },
      { status: 500 }
    );
  }
};
