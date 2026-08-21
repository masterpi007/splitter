import type { AuthEnv } from './types/auth';
import { sweepExpired } from './utils/db';

// Roughly one request in 200 clears expired rows. Pages Functions have no
// cron triggers (that is a Workers feature), so the alternative would be a
// second Worker deployment just for this; piggy-backing on real traffic is
// enough for tables that only collect spent challenges and dead sessions.
const SWEEP_PROBABILITY = 0.005;

// All /api responses are per-user, live data — forbid HTTP caching so a
// normal page reload never serves a stale group/profile from browser cache.
export const onRequest: PagesFunction<AuthEnv> = async (context) => {
  if (Math.random() < SWEEP_PROBABILITY) {
    // waitUntil: the sweep must never delay the response it rode in on.
    context.waitUntil(
      sweepExpired(context.env).catch((err) => console.error('Sweep failed:', err)),
    );
  }

  // Server-Timing: real time spent inside the function (Date.now only
  // advances across I/O in Workers, so this effectively measures awaited
  // D1/fetch time). Lets DevTools separate "backend slow" from "edge slow".
  // The start/finish logs pair up in the dashboard's real-time logs: a
  // "start" with no matching "finish" pinpoints a hung request.
  const t0 = Date.now();
  const path = new URL(context.request.url).pathname;
  console.log(`start ${context.request.method} ${path}`);
  const response = await context.next();
  const ms = Date.now() - t0;
  console.log(`finish ${context.request.method} ${path} ${response.status} ${ms}ms`);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Server-Timing', `fn;dur=${ms}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
