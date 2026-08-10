// App-wide admin authorization. Distinct from group admins (a group's
// `admins` memberId list): an app admin is a global identity that can perform
// privileged cross-group operations such as recovering another member's
// passkey. The set is configured via the APP_ADMIN_USER_IDS env var
// (comma-separated userIds) so it can change without a code deploy.

import type { AuthEnv } from '../types/auth';

export function isAppAdmin(env: AuthEnv, userId: string): boolean {
  if (!userId) return false;
  const raw = env.APP_ADMIN_USER_IDS ?? '';
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(userId);
}
