import type { AuthEnv } from '../../types/auth';
import { getTokenFromCookies, verifySession } from '../../utils/jwt';
import { createPasskeyInvite } from '../../utils/passkeyInvite';

// POST /api/auth/passkeys/invite - Create an invite for cross-device passkey
// registration for the CALLER's own account (self-serve "add a device").
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
    const origin = env.RP_ORIGIN || new URL(context.request.url).origin;

    const result = await createPasskeyInvite(env, {
      userId: session.userId,
      userName: session.userName,
      origin,
    });

    return Response.json({ success: true, data: result });
  } catch (error) {
    console.error('Create invite error:', error);
    return Response.json(
      { success: false, error: 'Failed to create invite' },
      { status: 500 }
    );
  }
};
