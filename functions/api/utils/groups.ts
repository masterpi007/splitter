// Data layer for groups, members, and expenses.
// Encapsulates KV access so the legacy single-group schema
// (keys 'group' and 'expenses', no admins/userId fields) remains
// readable/writable without a batch migration. The first read of
// a legacy record lazily adds the missing fields in place.

import type { AuthEnv } from '../types/auth';

export const LEGACY_GROUP_ID = '1matrix';

export interface GroupMember {
  id: string;
  userId?: string; // null for pre-created placeholders not yet claimed
  name: string;
  avatarSeed?: string;
  bankId?: string;
  bankName?: string;
  bankShortName?: string;
  accountName?: string;
  accountNo?: string;
  joinedAt?: string;
  removedAt?: string;
  // Weight for the "Split" method. Undefined/≤0 is treated as 1.
  share?: number;
}

export interface GroupRecord {
  id: string;
  name: string;
  currency: string;
  admins: string[]; // memberId[]
  members: GroupMember[];
  removedMembers: GroupMember[];
  createdBy?: string; // memberId of creator; may be absent for legacy
  createdAt: string;
}

export interface GroupSummary {
  id: string;
  name: string;
  memberCount: number;
}

const GROUP_INDEX_KEY = 'group-index';

function groupKey(groupId: string): string {
  return groupId === LEGACY_GROUP_ID ? 'group' : `group::${groupId}`;
}

function expensesKey(groupId: string): string {
  return groupId === LEGACY_GROUP_ID ? 'expenses' : `expenses::${groupId}`;
}

// Promote a raw KV record to the current GroupRecord shape.
// Idempotent — running twice produces the same result.
function promoteGroupShape(raw: any, expectedGroupId: string): GroupRecord {
  const members: GroupMember[] = (raw.members ?? []).map((m: any) => ({
    ...m,
    // Legacy invariant: userId === memberId for pre-existing members
    userId: m.userId ?? m.id,
  }));
  const removedMembers: GroupMember[] = (raw.removedMembers ?? []).map((m: any) => ({
    ...m,
    userId: m.userId ?? m.id,
  }));
  const admins: string[] = Array.isArray(raw.admins) && raw.admins.length > 0
    ? raw.admins
    // Legacy group has no admin info — promote every current member to co-admin.
    // The group owner can demote others later.
    : members.map((m) => m.id);

  return {
    id: expectedGroupId,
    name: raw.name ?? 'Expenses',
    currency: raw.currency ?? 'K',
    admins,
    members,
    removedMembers,
    createdBy: raw.createdBy,
    createdAt: raw.createdAt ?? new Date().toISOString(),
  };
}

// True if the promoted form differs from what's stored (i.e. needs write-back).
function needsPromotion(raw: any, expectedGroupId: string): boolean {
  if (!raw) return false;
  if (raw.id !== expectedGroupId) return true;
  if (!Array.isArray(raw.admins) || raw.admins.length === 0) return true;
  if (!Array.isArray(raw.removedMembers)) return true;
  if ((raw.members ?? []).some((m: any) => !m.userId)) return true;
  return false;
}

// Load a group by id. If the stored record is in legacy shape, promote it
// in memory before returning. We deliberately do NOT write the promoted
// record back from a read path: under concurrent reads interleaved with a
// saveGroup, a stale reader could otherwise overwrite a just-written
// mutation with the old promoted shape (a classic lost-update race). The
// next saveGroup call from any mutation path will persist the new shape,
// and reads in the meantime remain correct because promoteGroupShape is
// idempotent. Returns null if no record exists.
export async function getGroup(
  env: AuthEnv,
  groupId: string,
): Promise<GroupRecord | null> {
  const raw = await env.SPLITTER_KV.get<any>(groupKey(groupId), 'json');
  if (!raw) return null;
  if (needsPromotion(raw, groupId)) {
    return promoteGroupShape(raw, groupId);
  }
  return raw as GroupRecord;
}

export async function saveGroup(env: AuthEnv, group: GroupRecord): Promise<void> {
  await env.SPLITTER_KV.put(groupKey(group.id), JSON.stringify(group));
  await ensureInIndex(env, group.id);
}

export async function createGroup(
  env: AuthEnv,
  params: { name: string; currency: string; creator: GroupMember },
): Promise<GroupRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const creator: GroupMember = { ...params.creator, joinedAt: now };
  const group: GroupRecord = {
    id,
    name: params.name,
    currency: params.currency,
    admins: [creator.id],
    members: [creator],
    removedMembers: [],
    createdBy: creator.id,
    createdAt: now,
  };
  await saveGroup(env, group);
  return group;
}

// Mark a member as removed. Keeps the entry in removedMembers so existing
// expenses (which reference memberId) still render names in history.
export async function softRemoveMember(
  env: AuthEnv,
  group: GroupRecord,
  memberId: string,
): Promise<GroupRecord> {
  const idx = group.members.findIndex((m) => m.id === memberId);
  if (idx === -1) return group;
  const removed = { ...group.members[idx], removedAt: new Date().toISOString() };
  const updated: GroupRecord = {
    ...group,
    members: group.members.filter((m) => m.id !== memberId),
    removedMembers: [...group.removedMembers, removed],
    admins: group.admins.filter((id) => id !== memberId),
  };
  await saveGroup(env, updated);
  return updated;
}

// Return members (active + removed) so old expense rows still resolve names.
export function findMember(group: GroupRecord, memberId: string): GroupMember | undefined {
  return (
    group.members.find((m) => m.id === memberId) ??
    group.removedMembers.find((m) => m.id === memberId)
  );
}

export function isAdmin(group: GroupRecord, memberId: string): boolean {
  return group.admins.includes(memberId);
}

// --- Expenses ---

// 'group': splits across all current group members by share weight, resolved
// dynamically at read time. splits[] is persisted empty.
export type SplitType = 'equal' | 'exact' | 'percentage' | 'shares' | 'settlement' | 'group';
export const SPLIT_TYPES: SplitType[] = ['equal', 'exact', 'percentage', 'shares', 'settlement', 'group'];

export interface ExpenseSplit {
  memberId: string;
  value: number;
  amount: number;
  signedOff: boolean;
  signedAt?: string;
}

export interface GroupSignOff {
  memberId: string;
  signedAt: string;
}

export interface ExpenseHistoryChange {
  field: string;
  from?: unknown;
  to?: unknown;
}

// One recorded edit; creation and sign-offs are derived client-side instead.
export interface ExpenseHistoryEntry {
  at: string;
  by: string; // member id of the editor
  changes: ExpenseHistoryChange[];
}

export interface Expense {
  id: string;
  description: string;
  amount: number;
  paidBy: string;
  createdBy?: string;
  splitType: SplitType;
  splits: ExpenseSplit[];
  // Sign-off ledger for group-mode expenses.
  signedOffBy?: GroupSignOff[];
  createdAt: string;
  receiptUrl?: string;
  receiptDate?: string;
  tags?: string[];
  discount?: number;
  discountType?: string;
  // Recorded edits, server-appended in the PUT handler, capped at 50.
  history?: ExpenseHistoryEntry[];
}

export async function getExpenses(env: AuthEnv, groupId: string): Promise<unknown[]> {
  const data = await env.SPLITTER_KV.get<unknown[]>(expensesKey(groupId), 'json');
  return data ?? [];
}

export async function saveExpenses(
  env: AuthEnv,
  groupId: string,
  expenses: unknown[],
): Promise<void> {
  await env.SPLITTER_KV.put(expensesKey(groupId), JSON.stringify(expenses));
}

// Resolve member ids to their user ids (for user-scoped notifiers like
// Telegram). Members without a userId (unclaimed placeholders) are dropped.
export function memberIdsToUserIds(group: GroupRecord, memberIds: string[]): string[] {
  const out: string[] = [];
  for (const id of memberIds) {
    const m = findMember(group, id);
    if (m?.userId) out.push(m.userId);
  }
  return out;
}

// Validate untrusted expense input from the client. Returns an error message
// on failure, or null if valid. Checks: finite non-negative amount, valid
// splitType, paidBy + every split memberId resolves within the group, and
// per-split amount is finite/non-negative and reconciles to the total.
export function validateExpenseInput(
  group: GroupRecord,
  input: Partial<Expense>,
): string | null {
  if (typeof input.description !== 'string' || input.description.trim() === '') {
    return 'description is required';
  }
  if (!Number.isFinite(input.amount) || (input.amount as number) < 0) {
    return 'amount must be a non-negative finite number';
  }
  if (typeof input.splitType !== 'string' || !SPLIT_TYPES.includes(input.splitType as SplitType)) {
    return 'splitType is invalid';
  }
  if (typeof input.paidBy !== 'string' || !findMember(group, input.paidBy)) {
    return 'paidBy must reference a member of this group';
  }
  // Group-mode: splits are computed on read from current members + share
  // weights. We persist an empty array and validate the sign-off ledger
  // instead. The ledger lists members who have personally accepted the
  // transaction; when > 50% of active members are on it, the expense is
  // considered group-accepted.
  if (input.splitType === 'group') {
    if (!Array.isArray(input.splits)) {
      return 'splits must be an array';
    }
    if (input.signedOffBy !== undefined) {
      if (!Array.isArray(input.signedOffBy)) {
        return 'signedOffBy must be an array';
      }
      for (const entry of input.signedOffBy) {
        if (!entry || typeof entry !== 'object') return 'signedOffBy entry is invalid';
        if (typeof entry.memberId !== 'string' || !findMember(group, entry.memberId)) {
          return 'signedOffBy memberId must reference a member of this group';
        }
        if (typeof entry.signedAt !== 'string') {
          return 'signedOffBy signedAt must be a string';
        }
      }
    }
    return null;
  }
  if (!Array.isArray(input.splits) || input.splits.length === 0) {
    return 'splits must be a non-empty array';
  }
  let splitSum = 0;
  for (const split of input.splits) {
    if (!split || typeof split !== 'object') return 'split entry is invalid';
    if (typeof split.memberId !== 'string' || !findMember(group, split.memberId)) {
      return 'split memberId must reference a member of this group';
    }
    if (!Number.isFinite(split.amount) || split.amount < 0) {
      return 'split amount must be a non-negative finite number';
    }
    if (!Number.isFinite(split.value)) {
      return 'split value must be a finite number';
    }
    splitSum += split.amount;
  }
  // Allow 1-cent rounding per split; settlement rows don't have to reconcile
  // against the headline amount (it encodes payer/recipient differently).
  if (input.splitType !== 'settlement') {
    const tolerance = Math.max(0.01, input.splits.length * 0.01);
    if (Math.abs(splitSum - (input.amount as number)) > tolerance) {
      return 'splits do not sum to amount';
    }
  }
  return null;
}

// --- Group index ---
// Tracks non-legacy group ids so `listGroupIds` doesn't need a KV list scan.
// Legacy group is detected separately by checking the old 'group' key.

async function ensureInIndex(env: AuthEnv, groupId: string): Promise<void> {
  if (groupId === LEGACY_GROUP_ID) return;
  const index = (await env.SPLITTER_KV.get<string[]>(GROUP_INDEX_KEY, 'json')) ?? [];
  if (!index.includes(groupId)) {
    index.push(groupId);
    await env.SPLITTER_KV.put(GROUP_INDEX_KEY, JSON.stringify(index));
  }
}

export async function listGroupIds(env: AuthEnv): Promise<string[]> {
  const index = (await env.SPLITTER_KV.get<string[]>(GROUP_INDEX_KEY, 'json')) ?? [];
  const hasLegacy = (await env.SPLITTER_KV.get('group')) !== null;
  return hasLegacy ? [LEGACY_GROUP_ID, ...index.filter((id) => id !== LEGACY_GROUP_ID)] : index;
}

export async function getGroupSummaries(
  env: AuthEnv,
  groupIds: string[],
): Promise<GroupSummary[]> {
  const groups = await Promise.all(groupIds.map((id) => getGroup(env, id)));
  return groups
    .filter((g): g is GroupRecord => g !== null)
    .map((g) => ({ id: g.id, name: g.name, memberCount: g.members.length }));
}
