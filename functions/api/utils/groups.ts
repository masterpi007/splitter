// Data layer for groups, members, and expenses, backed by D1.
//
// The nested shapes below (a GroupRecord carrying its members, an Expense
// carrying its splits/items/tags/history) are what the rest of the codebase
// works with; utils/db.ts owns the flattening to and from rows. Every
// exported signature is unchanged from the KV implementation so handlers did
// not have to move.

import type { AuthEnv } from '../types/auth';
import {
  MEMBER_UPSERT_SQL,
  expenseWriteStatements,
  loadExpenses,
  memberBindings,
  rowToMember,
  type MemberRow,
} from './db';

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

// Assemble a GroupRecord from already-fetched rows. Exported so callers that
// batch the group + members queries with other statements (requireGroup)
// reuse the same mapping instead of paying a second D1 round trip.
export function buildGroupRecord(
  g: { id: string; name: string; currency: string; created_at: string },
  rows: MemberRow[],
): GroupRecord {
  const members: GroupMember[] = [];
  const removedMembers: GroupMember[] = [];
  const admins: string[] = [];
  for (const row of rows) {
    const member = rowToMember(row);
    if (member.removedAt) removedMembers.push(member);
    else {
      members.push(member);
      if (row.is_admin) admins.push(member.id);
    }
  }
  return {
    id: g.id,
    name: g.name,
    currency: g.currency,
    admins,
    members,
    removedMembers,
    createdAt: g.created_at,
  };
}

export async function getGroup(
  env: AuthEnv,
  groupId: string,
): Promise<GroupRecord | null> {
  const [groupRes, memberRes] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(groupId),
    env.DB.prepare(`SELECT * FROM members WHERE group_id = ? ORDER BY joined_at`).bind(groupId),
  ]);
  const g = groupRes.results?.[0] as
    | { id: string; name: string; currency: string; created_at: string }
    | undefined;
  if (!g) return null;

  return buildGroupRecord(g, memberRes.results as unknown as MemberRow[]);
}

// Whole-record save, mirroring the KV call sites that read a group, mutate
// the object and write it back. Members absent from the record are deleted;
// admin flags come from group.admins.
export async function saveGroup(env: AuthEnv, group: GroupRecord): Promise<void> {
  const all = [...group.members, ...group.removedMembers];
  const adminIds = new Set(group.admins);
  const keep = all.map((m) => m.id);
  const placeholders = keep.map(() => '?').join(', ') || "''";

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO groups (id, name, currency, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, currency = excluded.currency`,
    ).bind(group.id, group.name, group.currency, group.createdAt),
    ...all.map((m) =>
      env.DB.prepare(MEMBER_UPSERT_SQL).bind(...memberBindings(group.id, m, adminIds.has(m.id))),
    ),
    env.DB.prepare(
      `DELETE FROM members WHERE group_id = ? AND id NOT IN (${placeholders})`,
    ).bind(group.id, ...keep),
  ]);
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

// Mark a member as removed. The row stays so existing expenses (which
// reference memberId) still render names in history.
export async function softRemoveMember(
  env: AuthEnv,
  group: GroupRecord,
  memberId: string,
): Promise<GroupRecord> {
  const idx = group.members.findIndex((m) => m.id === memberId);
  if (idx === -1) return group;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE members SET removed_at = ?, is_admin = 0 WHERE id = ? AND group_id = ?`,
  )
    .bind(now, memberId, group.id)
    .run();
  const removed = { ...group.members[idx], removedAt: now };
  return {
    ...group,
    members: group.members.filter((m) => m.id !== memberId),
    removedMembers: [...group.removedMembers, removed],
    admins: group.admins.filter((id) => id !== memberId),
  };
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
  return loadExpenses(env, groupId);
}

// Whole-list save kept for the handlers that read every expense, mutate one
// and write the list back. Rows missing from the list are deleted; the rest
// are upserted, so a single-expense edit touches only that expense's rows.
export async function saveExpenses(
  env: AuthEnv,
  groupId: string,
  expenses: unknown[],
): Promise<void> {
  const list = expenses as Expense[];
  const keep = list.map((e) => e.id);
  const placeholders = keep.map(() => '?').join(', ') || "''";
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM expenses WHERE group_id = ? AND id NOT IN (${placeholders})`,
    ).bind(groupId, ...keep),
    ...list.flatMap((e) => expenseWriteStatements(env, groupId, e)),
  ]);
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

export async function listGroupIds(env: AuthEnv): Promise<string[]> {
  const res = await env.DB.prepare(`SELECT id FROM groups ORDER BY created_at`).all<{ id: string }>();
  return (res.results ?? []).map((r) => r.id);
}

export async function getGroupSummaries(
  env: AuthEnv,
  groupIds: string[],
): Promise<GroupSummary[]> {
  if (groupIds.length === 0) return [];
  const placeholders = groupIds.map(() => '?').join(', ');
  const res = await env.DB.prepare(
    `SELECT g.id, g.name,
            (SELECT count(*) FROM members m WHERE m.group_id = g.id AND m.removed_at IS NULL) AS member_count
       FROM groups g WHERE g.id IN (${placeholders})`,
  )
    .bind(...groupIds)
    .all<{ id: string; name: string; member_count: number }>();
  const byId = new Map((res.results ?? []).map((r) => [r.id, r]));
  // Preserve the caller's ordering (membership order, not insertion order).
  return groupIds
    .map((id) => byId.get(id))
    .filter((r): r is { id: string; name: string; member_count: number } => !!r)
    .map((r) => ({ id: r.id, name: r.name, memberCount: r.member_count }));
}
