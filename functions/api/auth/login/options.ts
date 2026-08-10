import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { AuthEnv } from '../../types/auth';
import { storeChallenge } from '../../utils/challenges';
import { getRp } from '../../utils/rp';

export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const env = context.env;

    // Generate authentication options for discoverable credentials
    // No allowCredentials = browser will show all available passkeys for this RP
    const options = await generateAuthenticationOptions({
      rpID: getRp(context.request, env).rpID,
      userVerification: 'preferred',
      // Empty allowCredentials for discoverable credential flow
    });

    // Store challenge with a temporary ID (will be resolved during verification)
    await storeChallenge(env, `login:${options.challenge}`, options.challenge, 'authentication');

    return Response.json({
      success: true,
      data: { options },
    });
  } catch (error) {
    console.error('Login options error:', error);
    return Response.json(
      { success: false, error: 'Failed to generate authentication options' },
      { status: 500 }
    );
  }
};
