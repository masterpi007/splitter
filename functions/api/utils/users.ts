// Global user identity, backed by D1.
//
// A user has zero or more group memberships. There is no separate membership
// record any more: a `members` row whose user_id matches (and which is not
// soft-removed) *is* the membership, which removes the class of bug where the
// two stores disagreed about who belonged to what.

import type { AuthEnv } from '../types/auth';

export interface User {
  id: string;
  name: string;
  // Global avatar identity — copied onto new member rows at group join and
  // kept in sync by profile saves, so the avatar follows the user everywhere.
  avatarSeed?: string;
  createdAt: string;
}

export interface UserMembership {
  groupId: string;
  memberId: string;
  joinedAt: string;
}

export async function getUser(env: AuthEnv, userId: string): Promise<User | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, avatar_seed, created_at FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{ id: string; name: string; avatar_seed: string | null; created_at: string }>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    avatarSeed: row.avatar_seed ?? undefined,
    createdAt: row.created_at,
  };
}

export async function saveUser(env: AuthEnv, user: User): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, name, avatar_seed, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar_seed = excluded.avatar_seed`,
  )
    .bind(user.id, user.name, user.avatarSeed ?? null, user.createdAt)
    .run();
}

export async function createUser(
  env: AuthEnv,
  params: { id?: string; name: string },
): Promise<User> {
  const user: User = {
    id: params.id ?? crypto.randomUUID(),
    name: params.name,
    createdAt: new Date().toISOString(),
  };
  await saveUser(env, user);
  return user;
}

export async function getMemberships(
  env: AuthEnv,
  userId: string,
): Promise<UserMembership[]> {
  const res = await env.DB.prepare(
    `SELECT group_id, id AS member_id, joined_at
       FROM members
      WHERE user_id = ? AND removed_at IS NULL
      ORDER BY joined_at`,
  )
    .bind(userId)
    .all<{ group_id: string; member_id: string; joined_at: string | null }>();
  return (res.results ?? []).map((r) => ({
    groupId: r.group_id,
    memberId: r.member_id,
    joinedAt: r.joined_at ?? '',
  }));
}

// Link an existing member row to a user. The row itself is created by the
// group/invite flow; this just claims it, so the call is idempotent.
export async function addMembership(
  env: AuthEnv,
  userId: string,
  membership: UserMembership,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE members
        SET user_id = ?, joined_at = coalesce(joined_at, ?)
      WHERE id = ? AND group_id = ?`,
  )
    .bind(userId, membership.joinedAt, membership.memberId, membership.groupId)
    .run();
}

// Leaving a group is a soft removal so past expenses still resolve the name.
export async function removeMembership(
  env: AuthEnv,
  userId: string,
  groupId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE members SET removed_at = coalesce(removed_at, ?), is_admin = 0
      WHERE user_id = ? AND group_id = ?`,
  )
    .bind(new Date().toISOString(), userId, groupId)
    .run();
}

export async function isUserMemberOfGroup(
  env: AuthEnv,
  userId: string,
  groupId: string,
): Promise<UserMembership | null> {
  const row = await env.DB.prepare(
    `SELECT group_id, id AS member_id, joined_at
       FROM members
      WHERE user_id = ? AND group_id = ? AND removed_at IS NULL`,
  )
    .bind(userId, groupId)
    .first<{ group_id: string; member_id: string; joined_at: string | null }>();
  return row
    ? { groupId: row.group_id, memberId: row.member_id, joinedAt: row.joined_at ?? '' }
    : null;
}
