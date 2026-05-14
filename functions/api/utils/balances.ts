// Server-side balance helpers. Mirrors src/utils/balances.ts logic so the
// API can gate destructive operations (member remove, group delete) on
// zero-balance pre-conditions without a round-trip to the client.

import type { GroupMember } from './groups';

interface ExpenseSplit {
  memberId: string;
  amount: number;
  value: number;
  signedOff?: boolean;
}

interface GroupSignOff {
  memberId: string;
  signedAt: string;
}

interface Expense {
  id: string;
  paidBy: string;
  amount: number;
  splitType: string;
  splits: ExpenseSplit[];
  signedOffBy?: GroupSignOff[];
  tags?: string[];
  items?: { memberId?: string; amount: number }[];
}

function isDeleted(e: Expense): boolean {
  return e.tags?.includes('deleted') ?? false;
}

// True when > 50% of active members have signed off.
function isGroupAccepted(expense: Expense, activeMembers: GroupMember[]): boolean {
  if (expense.splitType !== 'group') return false;
  if (activeMembers.length === 0) return false;
  const activeIds = new Set(activeMembers.map((m) => m.id));
  const signed = (expense.signedOffBy ?? []).filter((s) => activeIds.has(s.memberId)).length;
  return signed / activeMembers.length > 0.5;
}

// Resolve group-mode expense into per-member split amounts.
function resolveGroupSplits(expense: Expense, activeMembers: GroupMember[]): Map<string, number> {
  if (activeMembers.length === 0) return new Map();
  const total = expense.amount;
  const entries: [string, number][] = activeMembers.map((m) => [
    m.id,
    m.share && m.share > 0 ? m.share : 1,
  ]);
  const totalWeight = entries.reduce((s, [, w]) => s + w, 0);
  const result = new Map<string, number>();
  let remaining = total;
  entries.forEach(([id, w], i) => {
    if (i === entries.length - 1) {
      result.set(id, Math.round(remaining * 100) / 100);
    } else {
      const share = Math.round((total * w / totalWeight) * 100) / 100;
      result.set(id, share);
      remaining -= share;
    }
  });
  return result;
}

export interface MemberBalance {
  memberId: string;
  signedBalance: number;
  pendingBalance: number;
  totalBalance: number;
}

// Calculate signed and pending balances for every active member.
// Mirrors the frontend calculateBalances / resolveExpenseSplits logic.
export function calculateBalances(
  expenses: unknown[],
  members: GroupMember[],
): MemberBalance[] {
  const activeMembers = members.filter((m) => !m.removedAt);
  const signedMap = new Map<string, number>(activeMembers.map((m) => [m.id, 0]));
  const pendingMap = new Map<string, number>(activeMembers.map((m) => [m.id, 0]));

  const activeExpenses = (expenses as Expense[]).filter((e) => !isDeleted(e));

  for (const expense of activeExpenses) {
    const isGroup = expense.splitType === 'group';
    const groupAccepted = isGroup ? isGroupAccepted(expense, activeMembers) : false;

    // Resolve splits: group-mode computes them; others use stored splits.
    const splits: { memberId: string; amount: number; signedOff: boolean }[] = [];
    if (isGroup) {
      const amounts = resolveGroupSplits(expense, activeMembers);
      const ledger = new Set((expense.signedOffBy ?? []).map((s) => s.memberId));
      for (const [memberId, amount] of amounts) {
        splits.push({ memberId, amount, signedOff: ledger.has(memberId) });
      }
    } else {
      for (const s of expense.splits) {
        splits.push({ memberId: s.memberId, amount: s.amount, signedOff: s.signedOff ?? false });
      }
    }

    const unassignedAmount = (expense.items ?? [])
      .filter((item) => !item.memberId)
      .reduce((s, item) => s + item.amount, 0);

    let payerSignedCredit = 0;
    let payerPendingCredit = 0;

    for (const split of splits) {
      if (split.memberId === expense.paidBy) continue;
      if (!signedMap.has(split.memberId)) continue; // removed member — skip

      const goesToSigned = isGroup ? groupAccepted : split.signedOff;
      const map = goesToSigned ? signedMap : pendingMap;
      map.set(split.memberId, (map.get(split.memberId) ?? 0) - split.amount);

      if (goesToSigned) payerSignedCredit += split.amount;
      else payerPendingCredit += split.amount;
    }

    if (!signedMap.has(expense.paidBy)) continue; // payer was removed — skip

    if (payerSignedCredit !== 0) {
      signedMap.set(expense.paidBy, (signedMap.get(expense.paidBy) ?? 0) + payerSignedCredit);
    }
    const totalPending = payerPendingCredit + unassignedAmount;
    if (totalPending !== 0) {
      pendingMap.set(expense.paidBy, (pendingMap.get(expense.paidBy) ?? 0) + totalPending);
    }
  }

  return activeMembers.map((m) => {
    const signed = signedMap.get(m.id) ?? 0;
    const pending = pendingMap.get(m.id) ?? 0;
    return {
      memberId: m.id,
      signedBalance: signed,
      pendingBalance: pending,
      totalBalance: signed + pending,
    };
  });
}

const EPSILON = 0.005; // half a cent — rounding noise threshold

export function isBalanceClear(b: MemberBalance): boolean {
  return Math.abs(b.totalBalance) < EPSILON && Math.abs(b.pendingBalance) < EPSILON;
}
