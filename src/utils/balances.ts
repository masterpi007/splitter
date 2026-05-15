import { Expense, ExpenseSplit, Member, MemberBalance, Settlement, DiscountType } from '../types';

// Check if an expense is soft-deleted
export function isDeleted(expense: Expense): boolean {
  return expense.tags?.includes('deleted') ?? false;
}

// Group-mode expenses persist an empty splits array; the per-member breakdown
// is re-derived from the current member list and share weights every time
// the expense is read. That way adding/removing a member, or adjusting a
// share, retroactively re-weights every past group expense — which is the
// whole point of the mode.
//
// Sign-off is tracked out-of-band on expense.signedOffBy (a member-id ledger)
// so personal acceptance isn't lost when splits are recomputed. Each
// hydrated split's signedOff reflects whether *that member* personally
// signed — this is what drives the "pending actions" list. The aggregate
// "transaction accepted" state (> 50% of active members) is computed via
// isGroupAccepted and affects balance settlement atomically.
//
// Non-group expenses pass through unchanged.
export function resolveExpenseSplits(
  expense: Expense,
  members: Member[],
): ExpenseSplit[] {
  if (expense.splitType !== 'group') return expense.splits;
  const active = members.filter((m) => !m.removedAt);
  if (active.length === 0) return [];
  const entries: [string, number][] = active.map((m) => [
    m.id,
    m.share && m.share > 0 ? m.share : 1,
  ]);
  const distributed = distributeByShares(expense.amount, entries, 2);
  const ledger = new Map<string, string>();
  for (const entry of expense.signedOffBy ?? []) {
    ledger.set(entry.memberId, entry.signedAt);
  }
  return entries.map(([memberId, value]) => {
    const ledgerSignedAt = ledger.get(memberId);
    return {
      memberId,
      value,
      amount: distributed.get(memberId) ?? 0,
      signedOff: ledgerSignedAt !== undefined,
      signedAt: ledgerSignedAt,
    };
  });
}

// True when > 50% of the group's active members have personally signed off
// on the given group-mode expense. Always false for non-group expenses.
export function isGroupAccepted(
  expense: Expense,
  members: Member[],
): boolean {
  if (expense.splitType !== 'group') return false;
  const active = members.filter((m) => !m.removedAt);
  if (active.length === 0) return false;
  const activeIds = new Set(active.map((m) => m.id));
  let signed = 0;
  for (const entry of expense.signedOffBy ?? []) {
    if (activeIds.has(entry.memberId)) signed++;
  }
  return signed * 2 > active.length;
}

// parseFloat() only understands '.' as the decimal separator, but users on
// comma-locale keyboards may still type ',' out of habit. Normalize first so
// we accept both. Returns NaN on empty/invalid input.
export function parseDecimal(raw: string): number {
  return parseFloat(raw.replace(',', '.'));
}

// Clean up what the user typed in a `type="text" inputMode="decimal"` field
// so the visible value can't drift from what parseDecimal will later accept.
// Strips non-numeric characters, collapses multiple decimal separators to
// one (keeping the first), and allows either '.' or ',' as the separator so
// the field reads naturally in mixed locales. Does not parse or validate —
// leading/trailing separators and the empty string come through as-is
// because the user may still be typing.
export function sanitizeDecimalInput(raw: string): string {
  let seenSep = false;
  let out = '';
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') {
      out += ch;
      continue;
    }
    if ((ch === '.' || ch === ',') && !seenSep) {
      out += ch;
      seenSep = true;
    }
  }
  return out;
}

export function calculateBalances(
  expenses: Expense[],
  members: Member[]
): MemberBalance[] {
  const signedMap = new Map<string, number>();
  const pendingMap = new Map<string, number>();

  // Initialize all members with 0 balance
  members.forEach((m) => {
    signedMap.set(m.id, 0);
    pendingMap.set(m.id, 0);
  });

  // Filter out deleted expenses from balance calculations
  const activeExpenses = expenses.filter((e) => !isDeleted(e));

  // Group-mode expenses are accepted atomically once > 50% of active members
  // sign off — until then the whole transaction stays pending (even for the
  // members who have personally signed). Cache the acceptance state per
  // expense so we don't recompute it per split below.
  const isGroupAcceptedMap = new Map<string, boolean>();
  for (const expense of activeExpenses) {
    if (expense.splitType === 'group') {
      isGroupAcceptedMap.set(expense.id, isGroupAccepted(expense, members));
    }
  }

  activeExpenses.forEach((expense) => {
    // Calculate unassigned amount from items - this goes to payer's PENDING balance
    const unassignedAmount = expense.items
      ? expense.items
          .filter((item) => !item.memberId)
          .reduce((sum, item) => sum + item.amount, 0)
      : 0;

    // First pass: calculate what each non-payer participant owes (their debt to payer)
    // and accumulate payer's credit based on each participant's signedOff status
    let payerSignedCredit = 0;
    let payerPendingCredit = 0;

    const isGroup = expense.splitType === 'group';
    const groupAccepted = isGroup ? isGroupAcceptedMap.get(expense.id) ?? false : false;

    expense.splits.forEach((split) => {
      if (split.memberId !== expense.paidBy) {
        // Group-mode: split membership in signed vs pending is atomic based
        // on the > 50% acceptance threshold. Non-group: per-member signedOff.
        const goesToSigned = isGroup ? groupAccepted : split.signedOff;
        // Participant: owes their split amount
        const map = goesToSigned ? signedMap : pendingMap;
        const currentBalance = map.get(split.memberId) || 0;
        map.set(split.memberId, currentBalance - split.amount);

        // Payer gets credit for this - goes to signed or pending based on THIS participant's status
        if (goesToSigned) {
          payerSignedCredit += split.amount;
        } else {
          payerPendingCredit += split.amount;
        }
      }
    });

    // Payer's balance: credit from what others owe them + unassigned items
    // Unassigned items go to PENDING balance (waiting to be claimed by someone)
    const payerTotalPendingCredit = payerPendingCredit + unassignedAmount;

    if (payerSignedCredit > 0) {
      const currentSigned = signedMap.get(expense.paidBy) || 0;
      signedMap.set(expense.paidBy, currentSigned + payerSignedCredit);
    }
    if (payerTotalPendingCredit > 0) {
      const currentPending = pendingMap.get(expense.paidBy) || 0;
      pendingMap.set(expense.paidBy, currentPending + payerTotalPendingCredit);
    }
  });

  return members.map((m) => {
    const signed = signedMap.get(m.id) || 0;
    const pending = pendingMap.get(m.id) || 0;
    return {
      memberId: m.id,
      memberName: m.name,
      signedBalance: signed,
      pendingBalance: pending,
      balance: signed + pending,
    };
  });
}

export function calculateSettlements(balances: MemberBalance[]): Settlement[] {
  // Work in integer cents. The previous implementation subtracted floats in
  // a loop, so across long chains of small amounts the cumulative drift
  // could leave a penny on the table or cause the advance-index checks
  // (`< 0.01`) to fire on the wrong iteration. Rounding to cents up front
  // and subtracting integers eliminates both.
  const CENTS = 100;
  const toCents = (n: number) => Math.round(n * CENTS);

  const settlements: Settlement[] = [];

  const debtors = balances
    .filter((b) => b.signedBalance < 0)
    .map((b) => ({ ...b, cents: -toCents(b.signedBalance) }))
    .filter((b) => b.cents > 0)
    .sort((a, b) => b.cents - a.cents);

  const creditors = balances
    .filter((b) => b.signedBalance > 0)
    .map((b) => ({ ...b, cents: toCents(b.signedBalance) }))
    .filter((b) => b.cents > 0)
    .sort((a, b) => b.cents - a.cents);

  let debtorIdx = 0;
  let creditorIdx = 0;

  while (debtorIdx < debtors.length && creditorIdx < creditors.length) {
    const debtor = debtors[debtorIdx];
    const creditor = creditors[creditorIdx];

    const settleCents = Math.min(debtor.cents, creditor.cents);

    if (settleCents > 0) {
      settlements.push({
        from: debtor.memberId,
        fromName: debtor.memberName,
        to: creditor.memberId,
        toName: creditor.memberName,
        amount: settleCents / CENTS,
      });
    }

    debtor.cents -= settleCents;
    creditor.cents -= settleCents;

    if (debtor.cents === 0) debtorIdx++;
    if (creditor.cents === 0) creditorIdx++;
  }

  return settlements;
}

export function formatCurrency(amount: number, currency: string): string {
  // Round to 1 decimal place
  const rounded = Math.round(amount * 10) / 10;

  if (currency === 'K') {
    return `${rounded.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}K`;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  }).format(rounded);
}

// Format number with thousands separator
export function formatNumber(value: number, decimals: number = 1): string {
  const rounded = Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
  return rounded.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

// Round a number to specified decimal places
export function roundNumber(value: number, decimals: number = 1): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// Format date as relative time
export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) {
    return 'just now';
  } else if (diffMins < 60) {
    return `${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  } else if (diffDays === 1) {
    return 'yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString();
  }
}

// Get date key for grouping (YYYY-MM-DD)
export function getDateKey(dateString: string): string {
  const date = new Date(dateString);
  return date.toISOString().split('T')[0];
}

// Monday 00:00 local time of the ISO week containing `date`
export function getISOWeekStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const shift = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + shift);
  return d;
}

function ymdKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface WeeklySpending {
  weekStart: string; // YYYY-MM-DD of the period start
  groupTotal: number;
  userShare: number;
}

// Aggregate expenses into weekly buckets (Mon–Sun). Settlements and deleted
// expenses are excluded — they are transfers, not spending.
// Weeks with no activity between first and last observed week are included
// with zero values so the chart reads as a continuous timeline.
export function calculateWeeklySpending(
  expenses: Expense[],
  currentUserId: string | null
): WeeklySpending[] {
  const map = new Map<string, { groupTotal: number; userShare: number }>();

  for (const expense of expenses) {
    if (isDeleted(expense)) continue;
    if (expense.splitType === 'settlement') continue;

    const when = new Date(expense.receiptDate || expense.createdAt);
    if (isNaN(when.getTime())) continue;

    const key = ymdKey(getISOWeekStart(when));
    const entry = map.get(key) || { groupTotal: 0, userShare: 0 };
    entry.groupTotal += expense.amount;
    if (currentUserId) {
      for (const split of expense.splits) {
        if (split.memberId === currentUserId) {
          entry.userShare += split.amount;
        }
      }
    }
    map.set(key, entry);
  }

  const keys = [...map.keys()].sort();
  if (keys.length === 0) return [];

  const [fy, fm, fd] = keys[0].split('-').map(Number);
  const [ly, lm, ld] = keys[keys.length - 1].split('-').map(Number);
  const first = new Date(fy, fm - 1, fd);
  const last = new Date(ly, lm - 1, ld);

  const result: WeeklySpending[] = [];
  for (let d = new Date(first); d.getTime() <= last.getTime(); d.setDate(d.getDate() + 7)) {
    const key = ymdKey(d);
    const entry = map.get(key) || { groupTotal: 0, userShare: 0 };
    result.push({ weekStart: key, ...entry });
  }
  return result;
}

export function calculateDailySpending(
  expenses: Expense[],
  currentUserId: string | null
): WeeklySpending[] {
  const map = new Map<string, { groupTotal: number; userShare: number }>();

  for (const expense of expenses) {
    if (isDeleted(expense)) continue;
    if (expense.splitType === 'settlement') continue;
    const when = new Date(expense.receiptDate || expense.createdAt);
    if (isNaN(when.getTime())) continue;
    const key = ymdKey(when);
    const entry = map.get(key) || { groupTotal: 0, userShare: 0 };
    entry.groupTotal += expense.amount;
    if (currentUserId) {
      for (const split of expense.splits) {
        if (split.memberId === currentUserId) entry.userShare += split.amount;
      }
    }
    map.set(key, entry);
  }

  const keys = [...map.keys()].sort();
  if (keys.length === 0) return [];

  const [fy, fm, fd] = keys[0].split('-').map(Number);
  const [ly, lm, ld] = keys[keys.length - 1].split('-').map(Number);
  const first = new Date(fy, fm - 1, fd);
  const last = new Date(ly, lm - 1, ld);

  const result: WeeklySpending[] = [];
  for (let d = new Date(first); d.getTime() <= last.getTime(); d.setDate(d.getDate() + 1)) {
    const key = ymdKey(d);
    result.push({ weekStart: key, ...(map.get(key) || { groupTotal: 0, userShare: 0 }) });
  }
  return result;
}

export function calculateMonthlySpending(
  expenses: Expense[],
  currentUserId: string | null
): WeeklySpending[] {
  const map = new Map<string, { groupTotal: number; userShare: number }>();

  for (const expense of expenses) {
    if (isDeleted(expense)) continue;
    if (expense.splitType === 'settlement') continue;
    const when = new Date(expense.receiptDate || expense.createdAt);
    if (isNaN(when.getTime())) continue;
    const key = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-01`;
    const entry = map.get(key) || { groupTotal: 0, userShare: 0 };
    entry.groupTotal += expense.amount;
    if (currentUserId) {
      for (const split of expense.splits) {
        if (split.memberId === currentUserId) entry.userShare += split.amount;
      }
    }
    map.set(key, entry);
  }

  const keys = [...map.keys()].sort();
  if (keys.length === 0) return [];

  const [fy, fm] = keys[0].split('-').map(Number);
  const [ly, lm] = keys[keys.length - 1].split('-').map(Number);

  const result: WeeklySpending[] = [];
  let year = fy, month = fm;
  while (year < ly || (year === ly && month <= lm)) {
    const key = `${year}-${String(month).padStart(2, '0')}-01`;
    result.push({ weekStart: key, ...(map.get(key) || { groupTotal: 0, userShare: 0 }) });
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return result;
}

// Format date key as display header
export function formatDateHeader(dateKey: string): string {
  const date = new Date(dateKey + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const targetDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (targetDate.getTime() === today.getTime()) {
    return 'Today';
  } else if (targetDate.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  } else {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  }
}

// Generate consistent color classes for tags based on name
const TAG_COLORS = [
  { bg: 'bg-purple-900', text: 'text-purple-300', hoverBg: 'hover:bg-purple-800' },
  { bg: 'bg-blue-900', text: 'text-blue-300', hoverBg: 'hover:bg-blue-800' },
  { bg: 'bg-green-900', text: 'text-green-300', hoverBg: 'hover:bg-green-800' },
  { bg: 'bg-pink-900', text: 'text-pink-300', hoverBg: 'hover:bg-pink-800' },
  { bg: 'bg-indigo-900', text: 'text-indigo-300', hoverBg: 'hover:bg-indigo-800' },
  { bg: 'bg-teal-900', text: 'text-teal-300', hoverBg: 'hover:bg-teal-800' },
  { bg: 'bg-amber-900', text: 'text-amber-300', hoverBg: 'hover:bg-amber-800' },
  { bg: 'bg-rose-900', text: 'text-rose-300', hoverBg: 'hover:bg-rose-800' },
];

export function getTagColor(tag: string): { bg: string; text: string; hoverBg: string } {
  // Simple hash based on tag characters
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = ((hash << 5) - hash) + tag.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  const index = Math.abs(hash) % TAG_COLORS.length;
  return TAG_COLORS[index];
}

/** Convert an ISO string to a datetime-local input value */
export function toLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** Safely parse a datetime-local input value to an ISO string */
export function parseDatetimeLocal(value: string): string {
  // datetime-local gives "YYYY-MM-DDTHH:mm" — treat as local time
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (parts) {
    const d = new Date(+parts[1], +parts[2] - 1, +parts[3], +parts[4], +parts[5]);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Fallback: try native parsing
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

export function calculateDiscountAmount(
  discount: number | undefined,
  discountType: DiscountType | undefined,
  subtotal: number
): number {
  if (!discount || discount <= 0 || subtotal <= 0) return 0;
  if (discountType === 'flat') return Math.min(discount, subtotal);
  const pct = discount / 100;
  if (pct >= 1) return 0;
  return roundNumber(subtotal * pct, 2);
}

/**
 * Calculate the pre-discount subtotal (billGoc) from the post-discount total.
 * For percentage: subtotal = total / (1 - pct/100)
 * For flat: subtotal = total + discount
 */
export function calculateBillGoc(
  total: number,
  discount: number | undefined,
  discountType: DiscountType | undefined
): number {
  if (!discount || discount <= 0) return total;
  if (discountType === 'flat') return roundNumber(total + discount, 2);
  const pct = discount / 100;
  if (pct >= 1) return total;
  return roundNumber(total / (1 - pct), 2);
}

/**
 * Distribute a total amount across shares using largest-remainder method,
 * ensuring the split amounts sum exactly to the total.
 */
export function distributeByShares(
  total: number,
  shares: [string, number][],
  decimals: number = 2
): Map<string, number> {
  const result = new Map<string, number>();
  const totalShares = shares.reduce((sum, [, s]) => sum + s, 0);
  if (totalShares === 0) return result;

  const factor = Math.pow(10, decimals);
  const totalCents = Math.round(total * factor);

  let allocated = 0;
  const entries: { id: string; floored: number; remainder: number }[] = [];

  for (const [id, share] of shares) {
    const exact = (totalCents * share) / totalShares;
    const floored = Math.floor(exact);
    entries.push({ id, floored, remainder: exact - floored });
    allocated += floored;
  }

  // Distribute remaining cents to entries with largest remainders
  let remaining = totalCents - allocated;
  entries.sort((a, b) => b.remainder - a.remainder);
  for (const entry of entries) {
    if (remaining <= 0) break;
    entry.floored += 1;
    remaining -= 1;
  }

  for (const entry of entries) {
    result.set(entry.id, entry.floored / factor);
  }
  return result;
}
