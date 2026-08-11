// Short-lived advisory lock, now backed by the D1 ephemeral table.
//
// Expense writes no longer need this — they target a single row — but the
// invite-accept flow still serialises its membership check + insert so a
// double-tap cannot create two member rows for one user. Unlike the KV
// version this is strongly consistent, so the "both callers read an empty
// lock in the same tick" window is much smaller; the unique index on
// (group_id, user_id) is the real backstop.

import type { AuthEnv } from '../types/auth';
import { getEphemeral, putEphemeral, deleteEphemeral } from './db';

const LOCK_TTL_SECONDS = 60;

export interface LockHandle {
  release: () => Promise<void>;
}

export async function acquireLock(env: AuthEnv, key: string): Promise<LockHandle | null> {
  const fullKey = `lock::${key}`;
  const existing = await getEphemeral<{ held: true }>(env, fullKey);
  if (existing) return null;
  await putEphemeral(env, fullKey, 'lock', { held: true }, LOCK_TTL_SECONDS);
  return {
    release: async () => {
      await deleteEphemeral(env, fullKey).catch(() => {});
    },
  };
}
