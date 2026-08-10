import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthEnv, StoredCredential } from '../../types/auth';
import { getTokenFromCookies, verifySession } from '../../utils/jwt';
import { consumeChallenge } from '../../utils/challenges';
import { addCredential } from '../../utils/credentials';
import { getRp } from '../../utils/rp';

interface LinkPasskeyVerifyRequest {
  credential: {
    id: string;
    response: {
      transports?: string[];
    };
  };
  friendlyName?: string;
}

// POST /api/auth/passkeys/verify - Verify and link a new passkey to authenticated user
export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const token = getTokenFromCookies(context.request);

    if (!token) {
      return Response.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const session = await verifySession(context.env, token);

    if (!session) {
      return Response.json(
        { success: false, error: 'Session expired' },
        { status: 401 }
      );
    }

    const { credential, friendlyName } = await context.request.json() as LinkPasskeyVerifyRequest;

    if (!credential) {
      return Response.json(
        { success: false, error: 'credential is required' },
        { status: 400 }
      );
    }

    const env = context.env;
    const { userId } = session;

    // Get and consume the challenge (one-time use)
    const expectedChallenge = await consumeChallenge(env, userId, 'registration');
    if (!expectedChallenge) {
      return Response.json(
        { success: false, error: 'Challenge expired or not found. Please try again.' },
        { status: 400 }
      );
    }

    const { rpID, origin } = getRp(context.request, env);

    // Verify the registration response
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

    const { registrationInfo } = verification;

    // Store the credential
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

    // Return success without creating a new session (user is already logged in)
    return Response.json({
      success: true,
      data: { verified: true },
    });
  } catch (error) {
    console.error('Link passkey verification error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: `Failed to verify registration: ${errorMessage}` },
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
