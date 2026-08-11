/**
 * Web Push utility for Cloudflare Workers.
 * Uses Web Crypto API only (no Node.js crypto, no web-push npm).
 * Implements VAPID (RFC 8292) and message encryption (RFC 8291, aes128gcm).
 */
import type { AuthEnv, PushSubscriptionRecord, NotificationRecord, NotifyPrefs, NotifyEvent } from '../types/auth';
import { KV_KEYS, DEFAULT_NOTIFY_PREFS } from '../types/auth';
import type { GroupRecord } from './groups';
import { findMember } from './groups';
import { getNotifications, saveNotifications, getPushPrefs, getPushSubscriptions, deletePushSubscription } from './db';

const MAX_NOTIFICATIONS = 50; // Keep last 50 per (user, group)

// --- Base64url helpers ---

function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- VAPID JWT (ES256 / ECDSA P-256) ---

async function importVapidPrivateKey(
  privateKeyBase64url: string,
  publicKeyBase64url: string,
): Promise<CryptoKey> {
  const publicKeyBytes = base64urlDecode(publicKeyBase64url);
  // publicKeyBytes = 65 bytes: 0x04 || x (32) || y (32)
  const x = base64urlEncode(publicKeyBytes.slice(1, 33));
  const y = base64urlEncode(publicKeyBytes.slice(33, 65));

  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d: privateKeyBase64url },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

async function createVapidAuthHeader(
  audience: string,
  subject: string,
  publicKey: string,
  privateKey: string,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours

  const header = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
  );
  const payload = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({ aud: audience, exp, sub: subject })),
  );
  const unsignedToken = `${header}.${payload}`;

  const key = await importVapidPrivateKey(privateKey, publicKey);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsignedToken),
  );
  // WebCrypto ECDSA returns IEEE P1363 format (r||s, 64 bytes) — same as JWT ES256
  const jwt = `${unsignedToken}.${base64urlEncode(signature)}`;

  return `vapid t=${jwt}, k=${publicKey}`;
}

// --- RFC 8291: Push Message Encryption (aes128gcm) ---

async function encryptPayload(
  subscription: PushSubscriptionRecord,
  payload: string,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(payload);

  // 1. Generate ephemeral server ECDH key pair
  const serverKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );

  // 2. Import client's p256dh public key
  const clientPublicKeyBytes = base64urlDecode(subscription.keys.p256dh);
  const clientPublicKey = await crypto.subtle.importKey(
    'raw',
    clientPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // 3. ECDH shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPublicKey },
    serverKeys.privateKey,
    256,
  );

  // 4. Export server public key (uncompressed, 65 bytes)
  const serverPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKeys.publicKey),
  );

  // 5. Auth secret from subscription
  const authSecret = base64urlDecode(subscription.keys.auth);

  // 6. Random 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 7. Derive PRK via HKDF
  // info = "WebPush: info\0" || client_public_key || server_public_key
  const keyInfoHeader = encoder.encode('WebPush: info\0');
  const keyInfo = new Uint8Array(
    keyInfoHeader.length + clientPublicKeyBytes.length + serverPublicKeyBytes.length,
  );
  keyInfo.set(keyInfoHeader, 0);
  keyInfo.set(clientPublicKeyBytes, keyInfoHeader.length);
  keyInfo.set(serverPublicKeyBytes, keyInfoHeader.length + clientPublicKeyBytes.length);

  const ikmKey = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );

  const prkBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: keyInfo },
    ikmKey,
    256,
  );

  const prkKey = await crypto.subtle.importKey(
    'raw',
    prkBits,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );

  // 8. Derive Content Encryption Key (16 bytes) and Nonce (12 bytes)
  const cekBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('Content-Encoding: aes128gcm\0') },
    prkKey,
    128,
  );

  const nonceBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('Content-Encoding: nonce\0') },
    prkKey,
    96,
  );

  // 9. Pad payload: content || 0x02 (delimiter)
  const paddedPayload = new Uint8Array(payloadBytes.length + 1);
  paddedPayload.set(payloadBytes, 0);
  paddedPayload[payloadBytes.length] = 0x02;

  // 10. Encrypt with AES-128-GCM
  const cek = await crypto.subtle.importKey(
    'raw',
    cekBits,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceBits, tagLength: 128 },
    cek,
    paddedPayload,
  );

  // 11. Build aes128gcm body:
  // salt (16) || record_size (4, uint32 BE) || key_id_len (1) || key_id (server pub key, 65) || ciphertext
  const recordSize = 4096;
  const headerLen = 16 + 4 + 1 + serverPublicKeyBytes.length;
  const body = new Uint8Array(headerLen + encrypted.byteLength);
  body.set(salt, 0);
  new DataView(body.buffer).setUint32(16, recordSize, false);
  body[20] = serverPublicKeyBytes.length;
  body.set(serverPublicKeyBytes, 21);
  body.set(new Uint8Array(encrypted), headerLen);

  return body;
}

// --- Public API ---

export async function sendPushNotification(
  env: AuthEnv,
  subscription: PushSubscriptionRecord,
  payload: { title: string; body: string; url?: string; tag?: string },
): Promise<'ok' | 'expired' | 'error'> {
  try {
    const payloadStr = JSON.stringify(payload);
    const encrypted = await encryptPayload(subscription, payloadStr);

    const endpoint = new URL(subscription.endpoint);
    const audience = `${endpoint.protocol}//${endpoint.host}`;

    const authorization = await createVapidAuthHeader(
      audience,
      env.VAPID_SUBJECT,
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
    );

    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': '86400',
      },
      body: encrypted,
    });

    if (response.status === 201) return 'ok';

    // 410 Gone or 404 = subscription expired/invalid — should be removed
    if (response.status === 410 || response.status === 404) return 'expired';

    console.error(`Push failed: ${response.status} ${await response.text()}`);
    return 'error';
  } catch (err) {
    console.error('Push notification error:', err);
    return 'error';
  }
}

// Send a notification to a set of members of a specific group.
// Resolves memberId → userId via the group record, then writes history and
// delivers push using (userId, groupId)-scoped KV keys.
export async function notifyMembers(
  env: AuthEnv,
  group: GroupRecord,
  memberIds: string[],
  payload: { title: string; body: string; url?: string; tag?: string },
  event?: NotifyEvent,
): Promise<void> {
  const resolved = memberIds
    .map((memberId) => {
      const m = findMember(group, memberId);
      return m?.userId ? { memberId, userId: m.userId } : null;
    })
    .filter((x): x is { memberId: string; userId: string } => x !== null);

  console.log(`[push] Notifying ${resolved.length}/${memberIds.length} members in group ${group.id}`);
  const tasks: Promise<void>[] = [];

  // Save notification history — scoped per (userId, groupId) so users only see
  // their active group's notifications in the bell. Each user's history is
  // independent so the reads and writes overlap.
  await Promise.all(
    resolved.map(async ({ userId }) => {
      const existing = await getNotifications(env, userId, group.id);
      const record: NotificationRecord = {
        id: crypto.randomUUID(),
        title: payload.title,
        body: payload.body,
        url: payload.url,
        createdAt: new Date().toISOString(),
        read: false,
      };
      const updated = [record, ...existing].slice(0, MAX_NOTIFICATIONS);
      await saveNotifications(env, userId, group.id, updated);
    }),
  );

  for (const { userId } of resolved) {
    if (event) {
      const prefs = await getPushPrefs(env, userId, group.id);
      if (!prefs[event]) continue;
    }
    const subscriptions = await getPushSubscriptions(env, userId, group.id);
    if (subscriptions.length === 0) continue;

    for (const sub of subscriptions) {
      tasks.push(
        sendPushNotification(env, sub, payload).then(async (result) => {
          if (result === 'expired') {
            // Drop just the dead endpoint; a row delete, not a blob rewrite.
            await deletePushSubscription(env, userId, sub.endpoint);
          }
        }),
      );
    }
  }

  await Promise.allSettled(tasks);
}
