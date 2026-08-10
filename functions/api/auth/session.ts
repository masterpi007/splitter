import type { AuthEnv } from '../types/auth';
import {
  getTokenFromCookies,
  verifySession,
  deleteSession,
  clearAuthCookie,
} from '../utils/jwt';
import { isAppAdmin } from '../utils/admin';

// GET /api/auth/session - Check current session
export const onRequestGet: PagesFunction<AuthEnv> = async (context) => {
  try {
    const token = getTokenFromCookies(context.request);

    if (!token) {
      return Response.json({
        success: true,
        data: { authenticated: false },
      });
    }

    const session = await verifySession(context.env, token);

    if (!session) {
      // Clear invalid cookie
      return new Response(
        JSON.stringify({
          success: true,
          data: { authenticated: false },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': clearAuthCookie(),
          },
        }
      );
    }

    return Response.json({
      success: true,
      data: {
        authenticated: true,
        session: {
          userId: session.userId,
          userName: session.userName,
          expiresAt: session.expiresAt,
          isAppAdmin: isAppAdmin(context.env, session.userId),
        },
      },
    });
  } catch (error) {
    console.error('Session check error:', error);
    return Response.json(
      { success: false, error: 'Failed to check session' },
      { status: 500 }
    );
  }
};

// DELETE /api/auth/session - Logout
export const onRequestDelete: PagesFunction<AuthEnv> = async (context) => {
  try {
    const token = getTokenFromCookies(context.request);

    if (token) {
      const session = await verifySession(context.env, token);
      if (session) {
        await deleteSession(context.env, session.sessionId);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: { loggedOut: true },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': clearAuthCookie(),
        },
      }
    );
  } catch (error) {
    console.error('Logout error:', error);
    return Response.json(
      { success: false, error: 'Failed to logout' },
      { status: 500 }
    );
  }
};
