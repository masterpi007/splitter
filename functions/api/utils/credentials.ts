// WebAuthn keyring, backed by D1.
//
// Credentials used to live in one KV blob per user, which made
// findCredentialOwner a full list-scan of every user's blob on each sign-in.
// Here the credential id is the primary key, so the same lookup is a single
// indexed read.

import type { StoredCredential, AuthEnv } from '../types/auth';
import type { AuthenticatorTransportFuture, CredentialDeviceType } from '@simplewebauthn/server';

// Helper to convert Uint8Array to base64url string for storage
export function uint8ArrayToBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// Helper to convert base64url string back to Uint8Array
export function base64ToUint8Array(base64: string): Uint8Array {
  const base64Std = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64Std.length % 4 === 0 ? '' : '='.repeat(4 - (base64Std.length % 4));
  const binary = atob(base64Std + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}

function rowToCredential(r: CredentialRow): StoredCredential {
  return {
    id: r.id,
    publicKey: base64ToUint8Array(r.public_key),
    counter: r.counter,
    deviceType: (r.device_type ?? 'singleDevice') as CredentialDeviceType,
    backedUp: r.backed_up === 1,
    transports: r.transports
      ? (JSON.parse(r.transports) as AuthenticatorTransportFuture[])
      : undefined,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? undefined,
    friendlyName: r.name ?? undefined,
  };
}

const SELECT_COLUMNS = `id, user_id, public_key, counter, transports, device_type,
                        backed_up, name, created_at, last_used_at`;

export async function getCredentials(
  env: AuthEnv,
  memberId: string,
): Promise<StoredCredential[]> {
  const res = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM credentials WHERE user_id = ? ORDER BY created_at`,
  )
    .bind(memberId)
    .all<CredentialRow>();
  return (res.results ?? []).map(rowToCredential);
}

export async function addCredential(
  env: AuthEnv,
  memberId: string,
  credential: StoredCredential,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type,
                              backed_up, name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       counter = excluded.counter,
       transports = excluded.transports,
       name = excluded.name,
       last_used_at = excluded.last_used_at`,
  )
    .bind(
      credential.id,
      memberId,
      uint8ArrayToBase64(credential.publicKey),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      credential.deviceType ?? null,
      credential.backedUp ? 1 : 0,
      credential.friendlyName ?? null,
      credential.createdAt,
      credential.lastUsedAt ?? null,
    )
    .run();
}

// Bump the signature counter (and last-used stamp) after a successful login.
export async function updateCredential(
  env: AuthEnv,
  memberId: string,
  credentialId: string,
  updates: Partial<StoredCredential>,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (updates.counter !== undefined) {
    sets.push('counter = ?');
    binds.push(updates.counter);
  }
  if (updates.lastUsedAt !== undefined) {
    sets.push('last_used_at = ?');
    binds.push(updates.lastUsedAt);
  }
  if (updates.friendlyName !== undefined) {
    sets.push('name = ?');
    binds.push(updates.friendlyName);
  }
  if (sets.length === 0) return;
  binds.push(credentialId, memberId);
  await env.DB.prepare(
    `UPDATE credentials SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
  )
    .bind(...binds)
    .run();
}

export async function deleteCredential(
  env: AuthEnv,
  memberId: string,
  credentialId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM credentials WHERE id = ? AND user_id = ?`,
  )
    .bind(credentialId, memberId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function hasPasskeys(env: AuthEnv, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM credentials WHERE user_id = ? LIMIT 1`,
  )
    .bind(memberId)
    .first<{ present: number }>();
  return !!row;
}

export async function findCredentialById(
  env: AuthEnv,
  memberId: string,
  credentialId: string,
): Promise<StoredCredential | null> {
  const row = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM credentials WHERE id = ? AND user_id = ?`,
  )
    .bind(credentialId, memberId)
    .first<CredentialRow>();
  return row ? rowToCredential(row) : null;
}

// Discoverable-credential sign-in: the browser hands us only a credential id.
export async function findCredentialOwner(
  env: AuthEnv,
  credentialId: string,
): Promise<{ memberId: string; credential: StoredCredential } | null> {
  const row = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM credentials WHERE id = ?`,
  )
    .bind(credentialId)
    .first<CredentialRow>();
  return row ? { memberId: row.user_id, credential: rowToCredential(row) } : null;
}

// Remove every passkey for a user (admin-initiated recovery, account delete).
export async function deleteAllCredentials(env: AuthEnv, memberId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM credentials WHERE user_id = ?`).bind(memberId).run();
}
