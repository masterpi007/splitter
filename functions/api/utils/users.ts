// User identity layer. A User is global and owns passkey credentials;
// a User has zero or more group Memberships (one member record per group they belong to).
//
// Legacy invariant: for members that existed before multi-group support,
// userId === memberId. This lets existing `credentials:<memberId>` keys
// continue to work when read as `credentials:<userId>`, with no rewrite.

import type { AuthEnv } from '../types/auth';
import { LEGACY_GROUP_ID, getGroup, findMember } from './groups';

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

const userKey = (userId: string) => `user::${userId}`;
const membershipsKey = (userId: string) => `user::${userId}::memberships`;

// Resolve a user record. If no stored User exists but the userId matches a
// legacy 1matrix member, synthesize a User + membership once and write them back.
export async function getUser(env: AuthEnv, userId: string): Promise<User | null> {
  const stored = await env.SPLITTER_KV.get<User>(userKey(userId), 'json');
  if (stored) return stored;

  // Legacy bootstrap: check if this id is a member of the legacy group.
  const legacy = await getGroup(env, LEGACY_GROUP_ID);
  if (!legacy) return null;
  const member = findMember(legacy, userId);
  if (!member) return null;

  const user: User = {
    id: userId,
    name: member.name,
    createdAt: legacy.createdAt,
  };
  await saveUser(env, user);
  await addMembership(env, userId, {
    groupId: LEGACY_GROUP_ID,
    memberId: userId,
    joinedAt: member.joinedAt ?? legacy.createdAt,
  });
  return user;
}

export async function saveUser(env: AuthEnv, user: User): Promise<void> {
  await env.SPLITTER_KV.put(userKey(user.id), JSON.stringify(user));
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
  const stored = await env.SPLITTER_KV.get<UserMembership[]>(
    membershipsKey(userId),
    'json',
  );
  if (stored) return stored;

  // Legacy bootstrap: if the user is in the legacy group, seed it.
  const legacy = await getGroup(env, LEGACY_GROUP_ID);
  if (legacy && findMember(legacy, userId)) {
    const bootstrapped: UserMembership[] = [
      {
        groupId: LEGACY_GROUP_ID,
        memberId: userId,
        joinedAt: legacy.createdAt,
      },
    ];
    await env.SPLITTER_KV.put(membershipsKey(userId), JSON.stringify(bootstrapped));
    return bootstrapped;
  }

  return [];
}

export async function addMembership(
  env: AuthEnv,
  userId: string,
  membership: UserMembership,
): Promise<void> {
  const existing = await getMemberships(env, userId);
  // Dedupe by groupId — a user has at most one member row per group.
  const filtered = existing.filter((m) => m.groupId !== membership.groupId);
  filtered.push(membership);
  await env.SPLITTER_KV.put(membershipsKey(userId), JSON.stringify(filtered));
}

export async function removeMembership(
  env: AuthEnv,
  userId: string,
  groupId: string,
): Promise<void> {
  const existing = await getMemberships(env, userId);
  const filtered = existing.filter((m) => m.groupId !== groupId);
  await env.SPLITTER_KV.put(membershipsKey(userId), JSON.stringify(filtered));
}

export async function isUserMemberOfGroup(
  env: AuthEnv,
  userId: string,
  groupId: string,
): Promise<UserMembership | null> {
  const memberships = await getMemberships(env, userId);
  return memberships.find((m) => m.groupId === groupId) ?? null;
}
