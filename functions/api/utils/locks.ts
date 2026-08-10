// Short-lived advisory locks for serializing read-modify-write flows over KV.
// KV has no CAS primitive, so this is best-effort: two callers that both read
// an empty lock key within the same tick can still proceed concurrently. The
// goal is to narrow the race window for the common cases (double-clicks, a
// user racing themselves across tabs) — not to provide strict mutual
// exclusion. Anything requiring true atomicity should live in a Durable
// Object.

import type { AuthEnv } from '../types/auth';

const LOCK_TTL_SECONDS = 60;

export interface LockHandle {
  release: () => Promise<void>;
}

// Try to acquire `key`. Returns null when the lock is already held (caller
// should return a retry-safe response). Release with `handle.release()` in a
// finally block; the TTL guarantees stuck locks time out on their own.
// acquireLock with a few backoff retries — for short critical sections where
// brief contention (e.g. sequential accept-all sign-offs from one client,
// two members editing at once) should wait rather than fail.
export async function acquireLockWithRetry(
  env: AuthEnv,
  key: string,
  attempts = 5,
): Promise<LockHandle | null> {
  for (let i = 0; i < attempts; i++) {
    const lock = await acquireLock(env, key);
    if (lock) return lock;
    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
  }
  return null;
}

export async function acquireLock(env: AuthEnv, key: string): Promise<LockHandle | null> {
  const fullKey = `lock::${key}`;
  const existing = await env.SPLITTER_KV.get(fullKey);
  if (existing) return null;
  await env.SPLITTER_KV.put(fullKey, '1', { expirationTtl: LOCK_TTL_SECONDS });
  return {
    release: async () => {
      await env.SPLITTER_KV.delete(fullKey).catch(() => {});
    },
  };
}
