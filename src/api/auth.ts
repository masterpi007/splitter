import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { SessionInfo, PasskeyInfo, ApiResponse } from '../types';

const API_BASE = '/api/auth';

interface AuthApiResponse<T> extends ApiResponse<T> {
  code?: string;
}

async function fetchAuthApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    cache: 'no-store', // session state must never come from browser cache
    ...options,
    credentials: 'include', // Include cookies for session
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  const data: AuthApiResponse<T> = await response.json();

  if (!data.success) {
    const error = new Error(data.error || 'Auth request failed') as Error & { code?: string };
    error.code = data.code;
    throw error;
  }

  return data.data as T;
}

// Check if a user has passkeys registered. Accepts userId (new) or memberId
// (legacy — for the pre-multi-group single-group flow these are equal).
export async function checkHasPasskeys(userIdOrMemberId: string): Promise<boolean> {
  const result = await fetchAuthApi<{ hasPasskeys: boolean }>('/check', {
    method: 'POST',
    body: JSON.stringify({ userId: userIdOrMemberId }),
  });
  return result.hasPasskeys;
}

// Registration
export async function getRegistrationOptions(
  memberId: string,
  memberName: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const result = await fetchAuthApi<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    '/register/options',
    {
      method: 'POST',
      body: JSON.stringify({ memberId, memberName }),
    }
  );
  return result.options;
}

export async function verifyRegistration(
  memberId: string,
  memberName: string,
  credential: unknown,
  friendlyName?: string,
  inviteCode?: string,
): Promise<SessionInfo> {
  const result = await fetchAuthApi<{ verified: boolean; session: SessionInfo }>(
    '/register/verify',
    {
      method: 'POST',
      body: JSON.stringify({ memberId, memberName, credential, friendlyName, inviteCode }),
    }
  );
  if (!result.session) {
    throw new Error('Registration verification failed');
  }
  return result.session;
}

// Login (discoverable credentials - no memberId needed)
export async function getLoginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const result = await fetchAuthApi<{ options: PublicKeyCredentialRequestOptionsJSON }>(
    '/login/options',
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
  return result.options;
}

export async function verifyLogin(
  credential: unknown
): Promise<SessionInfo> {
  const result = await fetchAuthApi<{ verified: boolean; session: SessionInfo }>(
    '/login/verify',
    {
      method: 'POST',
      body: JSON.stringify({ credential }),
    }
  );
  if (!result.session) {
    throw new Error('Login verification failed');
  }
  return result.session;
}

// Session management
export async function checkSession(): Promise<{ authenticated: boolean; session?: SessionInfo }> {
  return fetchAuthApi<{ authenticated: boolean; session?: SessionInfo }>('/session');
}

export async function logout(): Promise<void> {
  await fetchAuthApi<{ loggedOut: boolean }>('/session', {
    method: 'DELETE',
  });
}

// Passkey management
export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const result = await fetchAuthApi<{ passkeys: PasskeyInfo[] }>('/passkeys');
  return result.passkeys;
}

export async function deletePasskey(passkeyId: string): Promise<void> {
  await fetchAuthApi<{ deleted: boolean }>(`/passkeys/${encodeURIComponent(passkeyId)}`, {
    method: 'DELETE',
  });
}

// Profile management
export async function updateProfile(name: string): Promise<SessionInfo> {
  const result = await fetchAuthApi<{ session: SessionInfo }>('/profile', {
    method: 'PUT',
    body: JSON.stringify({ name }),
  });
  return result.session;
}

// Link new passkey (for authenticated users)
export async function getLinkPasskeyOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const result = await fetchAuthApi<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    '/passkeys/options',
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
  return result.options;
}

export async function verifyLinkPasskey(
  credential: unknown,
  friendlyName?: string
): Promise<void> {
  await fetchAuthApi<{ verified: boolean }>(
    '/passkeys/verify',
    {
      method: 'POST',
      body: JSON.stringify({ credential, friendlyName }),
    }
  );
}

// Cross-device passkey invite
export interface PasskeyInviteInfo {
  inviteCode: string;
  inviteUrl: string;
  expiresAt: string;
}

export async function createPasskeyInvite(): Promise<PasskeyInviteInfo> {
  return fetchAuthApi<PasskeyInviteInfo>(
    '/passkeys/invite',
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
}

export async function getInvitePasskeyOptions(
  inviteCode: string
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; userName: string }> {
  return fetchAuthApi<{ options: PublicKeyCredentialCreationOptionsJSON; userName: string }>(
    '/passkeys/invite/options',
    {
      method: 'POST',
      body: JSON.stringify({ inviteCode }),
    }
  );
}

export async function verifyInvitePasskey(
  inviteCode: string,
  credential: unknown,
  friendlyName?: string
): Promise<SessionInfo> {
  const result = await fetchAuthApi<{ verified: boolean; session: SessionInfo }>(
    '/passkeys/invite/verify',
    {
      method: 'POST',
      body: JSON.stringify({ inviteCode, credential, friendlyName }),
    }
  );
  if (!result.session) {
    throw new Error('Invite verification failed');
  }
  return result.session;
}
