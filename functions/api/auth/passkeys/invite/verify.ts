import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthEnv, PasskeyInvite, StoredChallenge, StoredCredential } from '../../../types/auth';
import { KV_KEYS } from '../../../types/auth';
import { addCredential } from '../../../utils/credentials';
import { createSession, createAuthCookie } from '../../../utils/jwt';
import { getRp } from '../../../utils/rp';
import { getEphemeral, deleteEphemeral, putEphemeral } from '../../../utils/db';

interface InviteVerifyRequest {
  inviteCode: string;
  credential: {
    id: string;
    response: {
      transports?: string[];
    };
  };
  friendlyName?: string;
}

// POST /api/auth/passkeys/invite/verify - Verify and link passkey using an invite code
export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const { inviteCode, credential, friendlyName } = await context.request.json() as InviteVerifyRequest;

    if (!inviteCode || !credential) {
      return Response.json(
        { success: false, error: 'inviteCode and credential are required' },
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

    // Get and consume the challenge
    const challengeData = await getEphemeral<StoredChallenge>(env, KV_KEYS.inviteChallenge(inviteCode));

    if (!challengeData) {
      return Response.json(
        { success: false, error: 'Challenge expired or not found. Please try again.' },
        { status: 400 }
      );
    }

    // Delete the challenge immediately (one-time use)
    await deleteEphemeral(env, KV_KEYS.inviteChallenge(inviteCode));

    // Check if challenge has expired
    if (new Date(challengeData.expiresAt) < new Date()) {
      return Response.json(
        { success: false, error: 'Challenge has expired. Please try again.' },
        { status: 400 }
      );
    }

    const { rpID, origin } = getRp(context.request, env);

    // Verify the registration response
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return Response.json(
        { success: false, error: 'Registration verification failed' },
        { status: 400 }
      );
    }

    const { registrationInfo } = verification;
    const { userId, userName } = invite;

    const storedCredential: StoredCredential = {
      id: credential.id,
      publicKey: registrationInfo.credential.publicKey,
      counter: registrationInfo.credential.counter,
      deviceType: registrationInfo.credentialDeviceType,
      backedUp: registrationInfo.credentialBackedUp,
      transports: credential.response.transports,
      createdAt: new Date().toISOString(),
      friendlyName: friendlyName || getDefaultFriendlyName(context.request),
    };

    await addCredential(env, userId, storedCredential);

    await deleteEphemeral(env, KV_KEYS.invite(inviteCode));

    const { session, token } = await createSession(env, userId, userName);

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
    console.error('Invite verification error:', error);
    return Response.json(
      { success: false, error: 'Failed to verify registration' },
      { status: 500 }
    );
  }
};

// Helper to get a default friendly name from the request
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
