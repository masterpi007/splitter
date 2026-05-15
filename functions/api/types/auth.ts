import type {
  AuthenticatorTransportFuture,
  CredentialDeviceType,
} from '@simplewebauthn/server';

// Environment with auth config
export interface AuthEnv {
  SPLITTER_KV: KVNamespace;
  JWT_SECRET: string;
  RP_ID: string;
  RP_NAME: string;
  RP_ORIGIN: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
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

// Session stored in KV.
// `userId` is the global identity (owner of passkeys and memberships).
// Legacy sessions predating multi-group support will have userId === memberId;
// the session refresh in verifySession normalizes this.
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
// Registration only targets the legacy '1matrix' group where userId === memberId.
// Joining a non-legacy group is done via the invite-accept flow, which gates on
// a valid invite code and reuses the caller's existing userId.
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
  // Either userId (preferred) OR memberId (legacy — equals userId for pre-multi-group data).
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

// KV key helpers.
//
// `credentials(userId)` intentionally uses the same 'credentials:<id>' pattern
// as the pre-multi-group schema: legacy userId === memberId, so old records
// remain readable without rewriting.
//
// Push/notification/telegram keys are scoped by (userId, groupId) tuple so a
// user can be in multiple groups without their devices receiving cross-group
// notifications. Legacy single-key form is preserved via the two-arg signature
// supporting an absent groupId — callers in the new code path should always pass one.
export const KV_KEYS = {
  credentials: (userId: string) => `credentials:${userId}`,
  challenge: (userId: string) => `challenges:${userId}`,
  session: (sessionId: string) => `sessions:${sessionId}`,
  invite: (inviteCode: string) => `invites:${inviteCode}`,
  inviteChallenge: (inviteCode: string) => `invite-challenges:${inviteCode}`,
  pushSubscriptions: (userId: string, groupId?: string) =>
    groupId ? `push-subs:${userId}:${groupId}` : `push-subs:${userId}`,
  notifications: (userId: string, groupId?: string) =>
    groupId ? `notifications:${userId}:${groupId}` : `notifications:${userId}`,
  telegram: (userId: string) => `telegram:${userId}`,
  telegramConnect: (token: string) => `telegram:connect:${token}`,
  telegramChatId: (chatId: string) => `telegram:chatid:${chatId}`,
  pushPrefs: (userId: string, groupId?: string) =>
    groupId ? `push-prefs:${userId}:${groupId}` : `push-prefs:${userId}`,
  telegramRejectState: (chatId: string) => `telegram:reject-state:${chatId}`,
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
