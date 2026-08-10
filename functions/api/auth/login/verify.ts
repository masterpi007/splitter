import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthEnv } from '../../types/auth';
import { consumeChallenge } from '../../utils/challenges';
import {
  updateCredential,
  base64ToUint8Array,
  findCredentialOwner,
} from '../../utils/credentials';
import { createSession, createAuthCookie } from '../../utils/jwt';
import { getUser } from '../../utils/users';
import { getRp } from '../../utils/rp';

export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const { credential } = await context.request.json() as { credential: any };

    if (!credential) {
      return Response.json(
        { success: false, error: 'credential is required' },
        { status: 400 }
      );
    }

    const env = context.env;

    // findCredentialOwner scans credentials:<id> records; in the new schema
    // those ids are userIds. For legacy data the id is a memberId, which
    // matches userId by the legacy invariant.
    const credentialData = await findCredentialOwner(env, credential.id);
    if (!credentialData) {
      return Response.json(
        { success: false, error: 'Passkey not found. Please register first.' },
        { status: 400 }
      );
    }
    const userId = credentialData.memberId; // semantic rename: actually userId
    const storedCredential = credentialData.credential;

    // Consume the login challenge (keyed by the challenge value itself, since
    // discoverable credentials don't carry an identifier at challenge time).
    const clientDataJSON = JSON.parse(atob(credential.response.clientDataJSON));
    const challenge = clientDataJSON.challenge;
    const validChallenge = await consumeChallenge(env, `login:${challenge}`, 'authentication');
    if (!validChallenge) {
      return Response.json(
        { success: false, error: 'Challenge expired or not found. Please try again.' },
        { status: 400 }
      );
    }

    const { rpID, origin } = getRp(context.request, env);

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: validChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: base64ToUint8Array(storedCredential.id),
        publicKey: storedCredential.publicKey,
        counter: storedCredential.counter,
        transports: storedCredential.transports,
      },
    });

    if (!verification.verified) {
      return Response.json(
        { success: false, error: 'Authentication verification failed' },
        { status: 400 }
      );
    }

    await updateCredential(env, userId, storedCredential.id, {
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date().toISOString(),
    });

    // Resolve the user (lazy-bootstraps from legacy group if needed).
    const user = await getUser(env, userId);
    if (!user) {
      return Response.json(
        { success: false, error: 'User not found' },
        { status: 400 }
      );
    }

    const { session, token } = await createSession(env, user.id, user.name);

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
    console.error('Login verification error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: `Failed to verify authentication: ${errorMessage}` },
      { status: 500 }
    );
  }
};
