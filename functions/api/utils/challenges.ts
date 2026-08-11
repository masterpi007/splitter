// WebAuthn challenges, backed by D1's ephemeral table.
//
// Register/verify is two requests: one stores the challenge, the next reads
// it. Under KV those could land in different data centres and the read could
// miss a just-written challenge for up to 60s; D1 reads are consistent.

import type { StoredChallenge, AuthEnv } from '../types/auth';
import { CHALLENGE_TTL_SECONDS } from '../types/auth';
import { getEphemeral, deleteEphemeral, putEphemeral } from './db';

const key = (memberId: string) => `challenge:${memberId}`;

export async function storeChallenge(
  env: AuthEnv,
  memberId: string,
  challenge: string,
  type: 'registration' | 'authentication',
): Promise<void> {
  const now = Date.now();
  const record: StoredChallenge = {
    challenge,
    type,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
  };
  await putEphemeral(env, key(memberId), 'challenge', record, CHALLENGE_TTL_SECONDS);
}

// Single use: returns the challenge string and removes it, or null when
// missing, expired, or issued for a different ceremony.
export async function consumeChallenge(
  env: AuthEnv,
  memberId: string,
  expectedType: 'registration' | 'authentication',
): Promise<string | null> {
  const data = await getEphemeral<StoredChallenge>(env, key(memberId));
  if (!data) return null;
  await deleteEphemeral(env, key(memberId));
  if (new Date(data.expiresAt) < new Date()) return null;
  if (data.type !== expectedType) return null;
  return data.challenge;
}

export async function deleteChallenge(env: AuthEnv, memberId: string): Promise<void> {
  await deleteEphemeral(env, key(memberId));
}
