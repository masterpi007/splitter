import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { AuthEnv } from '../../types/auth';
import { getTokenFromCookies, verifySession } from '../../utils/jwt';
import { storeChallenge } from '../../utils/challenges';
import { getCredentials } from '../../utils/credentials';
import { getRp } from '../../utils/rp';

// POST /api/auth/passkeys/options - Get registration options for linking a new passkey
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

    const env = context.env;
    const { userId, userName } = session;

    // Get existing credentials to exclude them from registration
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

    // Store challenge for verification
    await storeChallenge(env, userId, options.challenge, 'registration');

    return Response.json({
      success: true,
      data: { options },
    });
  } catch (error) {
    console.error('Link passkey options error:', error);
    return Response.json(
      { success: false, error: 'Failed to generate registration options' },
      { status: 500 }
    );
  }
};
