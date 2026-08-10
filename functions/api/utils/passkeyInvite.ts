// Cross-device passkey invite creation. A passkey invite binds a short code
// to an existing identity (userId); when the code is opened at /invite/:code
// the holder can register a NEW passkey against that identity — used both for
// "add another device" (self-serve) and admin-driven "recover a lost passkey".
//
// The invite record lives at KV_KEYS.invite(code) and is consumed by
// /api/auth/passkeys/invite/{options,verify}. This module centralises the code
// generation + record shape so every caller produces identical invites.

import type { AuthEnv, PasskeyInvite } from '../types/auth';
import { KV_KEYS, INVITE_TTL_SECONDS } from '../types/auth';

// Short, easy-to-type code. Uppercase + digits, omitting ambiguous
// characters (0/O/I/1/L). Uppercase-only also keeps these codes disjoint from
// lowercase group-invite codes, so /invite/:code can tell the two flows apart.
export function generatePasskeyInviteCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[randomBytes[i] % chars.length];
  }
  return code;
}

export interface PasskeyInviteResult {
  inviteCode: string;
  inviteUrl: string;
  expiresAt: string;
}

// Create and persist a passkey invite for `userId`, returning the shareable
// link. `ttlSeconds` defaults to the standard self-serve invite window; the
// admin recovery flow passes a longer value so the link survives being
// relayed to the member out-of-band.
export async function createPasskeyInvite(
  env: AuthEnv,
  params: { userId: string; userName: string; origin: string; ttlSeconds?: number },
): Promise<PasskeyInviteResult> {
  const ttl = params.ttlSeconds ?? INVITE_TTL_SECONDS;
  const inviteCode = generatePasskeyInviteCode();
  const now = Date.now();
  const invite: PasskeyInvite = {
    inviteCode,
    userId: params.userId,
    userName: params.userName,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
  };

  await env.SPLITTER_KV.put(
    KV_KEYS.invite(inviteCode),
    JSON.stringify(invite),
    { expirationTtl: ttl },
  );

  return {
    inviteCode,
    inviteUrl: `${params.origin}/invite/${inviteCode}`,
    expiresAt: invite.expiresAt,
  };
}
