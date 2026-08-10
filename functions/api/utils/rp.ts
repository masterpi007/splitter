import type { AuthEnv } from '../types/auth';

// WebAuthn Relying Party identity, derived from the request URL so the app
// needs no per-domain configuration. RP_* env vars act as optional overrides
// (e.g. to pin one rpID across multiple hostnames).
export function getRp(request: Request, env: Pick<AuthEnv, 'RP_ID' | 'RP_NAME' | 'RP_ORIGIN'>) {
  const url = new URL(request.url);
  return {
    rpID: env.RP_ID || url.hostname,
    rpName: env.RP_NAME || 'Splitter',
    origin: env.RP_ORIGIN || url.origin,
  };
}
