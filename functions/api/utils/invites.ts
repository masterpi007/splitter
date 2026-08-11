// Permanent group invites, backed by D1. A code maps to a groupId; admins
// revoke via DELETE. The per-group index KV needed to avoid a list scan is
// gone — an indexed query on group_id replaces it, so codes can no longer
// dangle in an index after their record disappears.

import type { AuthEnv } from '../types/auth';

export interface GroupInvite {
  code: string;
  groupId: string;
  createdBy: string; // memberId of admin who created it
  createdAt: string;
  note?: string;
}

function randomCode(): string {
  // 16 base32 chars (~80 bits of entropy), URL-safe, readable.
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

interface InviteRow {
  code: string;
  group_id: string;
  created_by: string | null;
  created_at: string;
}

const rowToInvite = (r: InviteRow): GroupInvite => ({
  code: r.code,
  groupId: r.group_id,
  createdBy: r.created_by ?? '',
  createdAt: r.created_at,
});

export async function getInvite(env: AuthEnv, code: string): Promise<GroupInvite | null> {
  const row = await env.DB.prepare(
    `SELECT code, group_id, created_by, created_at FROM group_invites WHERE code = ?`,
  )
    .bind(code)
    .first<InviteRow>();
  return row ? rowToInvite(row) : null;
}

export async function createInvite(
  env: AuthEnv,
  params: { groupId: string; createdBy: string; note?: string },
): Promise<GroupInvite> {
  const invite: GroupInvite = {
    code: randomCode(),
    groupId: params.groupId,
    createdBy: params.createdBy,
    createdAt: new Date().toISOString(),
    note: params.note,
  };
  await env.DB.prepare(
    `INSERT INTO group_invites (code, group_id, created_by, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(invite.code, invite.groupId, invite.createdBy, invite.createdAt)
    .run();
  return invite;
}

export async function listGroupInvites(
  env: AuthEnv,
  groupId: string,
): Promise<GroupInvite[]> {
  const res = await env.DB.prepare(
    `SELECT code, group_id, created_by, created_at
       FROM group_invites WHERE group_id = ? ORDER BY created_at`,
  )
    .bind(groupId)
    .all<InviteRow>();
  return (res.results ?? []).map(rowToInvite);
}

export async function deleteInvite(env: AuthEnv, code: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM group_invites WHERE code = ?`).bind(code).run();
}
