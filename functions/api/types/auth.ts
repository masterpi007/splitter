import type {
  AuthenticatorTransportFuture,
  CredentialDeviceType,
} from '@simplewebauthn/server';

// Environment with auth config
export interface AuthEnv {
  DB: D1Database;
  JWT_SECRET: string;
  // WebAuthn Relying Party overrides. Absent ⇒ derived from the request URL
  // (see utils/rp.ts), which is correct for a single-domain deployment.
  RP_ID?: string;
  RP_NAME?: string;
  RP_ORIGIN?: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  // Comma-separated list of userIds with app-wide admin rights (e.g. passkey
  // recovery for any member of any group). Absent/empty ⇒ no app admins.
  APP_ADMIN_USER_IDS?: string;
}

// Stored WebAuthn credential for a user
export interface StoredCredential {
  id: string; // base64url encoded credential ID
  publicKey: Uint8Array;
  counter: number;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  transports?: AuthenticatorTransportFuture[];
  createdAt: string;
  lastUsedAt?: string;
  friendlyName?: string; // e.g., "iPhone 15", "MacBook Pro"
}

// Stored challenge for WebAuthn registration/authentication
export interface StoredChallenge {
  challenge: string;
  type: 'registration' | 'authentication';
  createdAt: string;
  expiresAt: string;
}

// `userId` is the global identity: owner of passkeys and memberships.
export interface Session {
  sessionId: string;
  userId: string;
  userName: string;
  createdAt: string;
  expiresAt: string;
}

// JWT payload
export interface JWTPayload {
  sessionId: string;
  userId: string;
  userName: string;
  iat: number;
  exp: number;
}

// API request/response types.
//
// Registration mints a standalone identity; joining a group goes through the
// invite-accept flow, which gates on a valid invite code and reuses the
// caller's existing userId.
export interface RegisterOptionsRequest {
  memberId: string; // member row to attach the passkey/user to
  memberName: string;
}

export interface RegisterOptionsResponse {
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface RegisterVerifyRequest {
  memberId: string;
  memberName: string;
  credential: RegistrationResponseJSON;
  friendlyName?: string;
}

export interface RegisterVerifyResponse {
  verified: boolean;
  session?: SessionInfo;
}

export interface LoginOptionsRequest {
  userId?: string;
  memberId?: string;
}

export interface LoginOptionsResponse {
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface LoginVerifyRequest {
  userId?: string;
  memberId?: string;
  credential: AuthenticationResponseJSON;
}

export interface LoginVerifyResponse {
  verified: boolean;
  session?: SessionInfo;
}

export interface SessionInfo {
  userId: string;
  userName: string;
  expiresAt: string;
}

export interface PasskeyInfo {
  id: string;
  createdAt: string;
  lastUsedAt?: string;
  friendlyName?: string;
}

// Re-export types from @simplewebauthn for convenience
export type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';

// Passkey invite for cross-device registration (user adds a new device
// to their own existing identity — distinct from a group invite).
export interface PasskeyInvite {
  inviteCode: string;
  userId: string;
  userName: string;
  createdAt: string;
  expiresAt: string;
}

// Push notification subscription (one per device)
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;  // base64url
    auth: string;    // base64url
  };
  createdAt: string;
  userAgent?: string;
}

// Notification history record
export interface NotificationRecord {
  id: string;
  title: string;
  body: string;
  url?: string;
  createdAt: string;
  read: boolean;
}

// Keys for the `ephemeral` table — short-lived tokens that used to be KV
// entries with a TTL. Only these five remain; everything else that lived in
// KV is now a proper table with its own columns.
export const KV_KEYS = {
  invite: (inviteCode: string) => `invites:${inviteCode}`,
  inviteChallenge: (inviteCode: string) => `invite-challenges:${inviteCode}`,
  telegramConnect: (token: string) => `telegram:connect:${token}`,
  debounceNotify: (expenseId: string) => `debounce:notify:${expenseId}`,
  telegramCallback: (token: string) => `tg-cb:${token}`,
} as const;

// Constants
export const CHALLENGE_TTL_SECONDS = 5 * 60; // 5 minutes
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const INVITE_TTL_SECONDS = 10 * 60; // 10 minutes
export const TELEGRAM_CONNECT_TTL_SECONDS = 10 * 60; // 10 minutes
export const TELEGRAM_REJECT_STATE_TTL_SECONDS = 5 * 60; // 5 minutes
export const DEBOUNCE_NOTIFY_TTL_SECONDS = 30; // 30 seconds
export const TELEGRAM_CALLBACK_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface TelegramCallbackData {
  action: string;
  groupId: string;
  expenseId: string;
}

// Telegram types
export type NotifyEvent = keyof NotifyPrefs;


export interface NotifyPrefs {
  newExpense: boolean;
  expenseEdited: boolean;
  expenseDeleted: boolean;
  settlementRequest: boolean;
  settlementAccepted: boolean;
  settlementRejected: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  newExpense: true,
  expenseEdited: true,
  expenseDeleted: true,
  settlementRequest: true,
  settlementAccepted: true,
  settlementRejected: true,
};

export interface TelegramData {
  chatId: string;
  telegramName?: string;
  connectedAt: string;
  notifyPrefs: NotifyPrefs;
}

export interface TelegramConnectToken {
  userId: string;
  expiresAt: string;
}

export interface TelegramRejectState {
  settlementExpenseId: string;
  step: 'awaiting_reason';
}
