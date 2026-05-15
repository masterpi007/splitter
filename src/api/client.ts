import {
  Group,
  GroupSummary,
  GroupInvite,
  Expense,
  ApiResponse,
  ReceiptOCRResult,
  NotificationRecord,
  NotifyPrefs,
} from '../types';
import type { Member } from '../types';

const API_BASE = '/api';

// Active group is held in localStorage so it survives reloads. No default —
// users create their first group after sign-in. The AppContext is the
// canonical reader/writer of this key.
const ACTIVE_GROUP_KEY = 'splitter.activeGroupId';

export function getActiveGroupId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(ACTIVE_GROUP_KEY);
}

export function setActiveGroupId(groupId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(ACTIVE_GROUP_KEY, groupId);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit & { groupId?: string },
): Promise<T> {
  const { groupId, ...init } = options ?? {};
  const activeGroupId = groupId ?? getActiveGroupId();
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(activeGroupId ? { 'X-Group-Id': activeGroupId } : {}),
      ...init?.headers,
    },
  });

  const data: ApiResponse<T> = await response.json();

  if (!data.success) {
    throw new ApiError(data.error || 'API request failed', response.status);
  }

  return data.data as T;
}

// --- Groups ---

export async function listGroups(): Promise<GroupSummary[]> {
  return fetchApi<GroupSummary[]>('/groups');
}

export async function createGroup(
  name: string,
  currency: string,
  displayName?: string,
): Promise<Group> {
  return fetchApi<Group>('/groups', {
    method: 'POST',
    body: JSON.stringify({ name, currency, displayName }),
  });
}

export async function getGroup(groupId?: string): Promise<Group> {
  return fetchApi<Group>('/group', groupId ? { groupId } : undefined);
}

export async function deleteGroup(groupId: string): Promise<void> {
  await fetchApi<void>(`/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
    groupId,
  });
}

export async function updateGroup(updates: Partial<Group>): Promise<Group> {
  return fetchApi<Group>('/group', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function removeMember(memberId: string): Promise<Group> {
  return fetchApi<Group>(`/groups/members/${encodeURIComponent(memberId)}`, {
    method: 'DELETE',
  });
}

// Update per-member admin-controlled settings (share for now).
// Passing `share: null` clears the override back to the implicit 1.
export async function updateMemberSettings(
  memberId: string,
  updates: { share?: number | null },
): Promise<Group> {
  return fetchApi<Group>(`/groups/members/${encodeURIComponent(memberId)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function updateAdmin(memberId: string, admin: boolean): Promise<Group> {
  return fetchApi<Group>('/groups/admins', {
    method: 'PUT',
    body: JSON.stringify({ memberId, admin }),
  });
}

// --- Friends (direct-add candidates) ---

export interface FriendCandidate {
  userId: string;
  name: string;
  groupNames: string[];
}

export async function listFriends(): Promise<FriendCandidate[]> {
  return fetchApi<FriendCandidate[]>('/groups/friends');
}

export async function addFriendToGroup(
  userId: string,
  displayName?: string,
): Promise<Group> {
  return fetchApi<Group>('/groups/members', {
    method: 'POST',
    body: JSON.stringify({ userId, displayName }),
  });
}

// --- Invites ---

export async function listInvites(): Promise<GroupInvite[]> {
  return fetchApi<GroupInvite[]>('/groups/invites');
}

export async function createInvite(note?: string): Promise<GroupInvite> {
  return fetchApi<GroupInvite>('/groups/invites', {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

export async function deleteInvite(code: string): Promise<void> {
  await fetchApi<void>(`/groups/invites/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  });
}

export interface InvitePreview {
  code: string;
  groupId: string;
  groupName: string;
  memberCount: number;
}

// Preview is public — no session / no X-Group-Id required.
export async function previewInvite(code: string): Promise<InvitePreview> {
  const response = await fetch(`${API_BASE}/groups/invites/${encodeURIComponent(code)}`);
  const data: ApiResponse<InvitePreview> = await response.json();
  if (!data.success) throw new Error(data.error || 'Invite not found');
  return data.data as InvitePreview;
}

export async function acceptInvite(
  code: string,
  displayName?: string,
): Promise<{ groupId: string; memberId: string; alreadyMember: boolean }> {
  // Accept is user-scoped but not group-scoped (the invite itself names the target group).
  // We still send X-Group-Id; the server reads groupId from the invite record.
  return fetchApi<{ groupId: string; memberId: string; alreadyMember: boolean }>(
    `/groups/invites/${encodeURIComponent(code)}`,
    {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    },
  );
}

// --- Expenses ---

export async function getExpenses(groupId?: string): Promise<Expense[]> {
  return fetchApi<Expense[]>('/expenses', groupId ? { groupId } : undefined);
}

export async function createExpense(
  expense: Omit<Expense, 'id' | 'createdAt'>,
): Promise<Expense> {
  return fetchApi<Expense>('/expenses', {
    method: 'POST',
    body: JSON.stringify(expense),
  });
}

export async function updateExpense(
  id: string,
  updates: Partial<Expense>,
): Promise<Expense> {
  return fetchApi<Expense>(`/expenses/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function deleteExpense(id: string): Promise<void> {
  await fetchApi<void>(`/expenses/${id}`, {
    method: 'DELETE',
  });
}

// Soft delete - mark expense with 'deleted' tag instead of actually deleting
export async function softDeleteExpense(expense: Expense): Promise<Expense> {
  const tags = expense.tags || [];
  if (!tags.includes('deleted')) {
    return updateExpense(expense.id, {
      tags: [...tags, 'deleted'],
    });
  }
  return expense;
}

// --- Receipt processing ---

export async function processReceipt(file: File): Promise<ReceiptOCRResult> {
  const formData = new FormData();
  formData.append('receipt', file);

  const activeGroupId = getActiveGroupId();
  const response = await fetch(`${API_BASE}/receipts/process`, {
    method: 'POST',
    headers: activeGroupId ? { 'X-Group-Id': activeGroupId } : undefined,
    body: formData,
  });

  const data: ApiResponse<{ extracted: ReceiptOCRResult['extracted'] }> = await response.json();

  if (!data.success || !data.data) {
    throw new Error(data.error || 'Failed to process receipt');
  }

  return {
    success: true,
    extracted: data.data.extracted,
  };
}

// --- Sign-off helper ---

export async function signOffExpense(
  expense: Expense,
  memberId: string,
): Promise<Expense> {
  // Group-mode: sign-offs live on a separate ledger (splits are ephemeral,
  // recomputed from the current member list on each read). Append to the
  // ledger instead of trying to mutate the computed splits.
  if (expense.splitType === 'group') {
    const ledger = expense.signedOffBy ?? [];
    if (ledger.some((entry) => entry.memberId === memberId)) return expense;
    const updatedLedger = [
      ...ledger,
      { memberId, signedAt: new Date().toISOString() },
    ];
    return updateExpense(expense.id, { signedOffBy: updatedLedger });
  }

  const updatedSplits = expense.splits.map((split) => {
    if (split.memberId === memberId && !split.signedOff) {
      return {
        ...split,
        signedOff: true,
        signedAt: new Date().toISOString(),
        previousAmount: undefined,
      };
    }
    return split;
  });

  return updateExpense(expense.id, { splits: updatedSplits });
}

// --- Profile ---

export async function updateProfile(updates: Partial<Member>): Promise<Member> {
  return fetchApi<Member>('/auth/profile', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function deleteAccount(): Promise<void> {
  await fetchApi<{ deleted: boolean }>('/auth/account', { method: 'DELETE' });
}

// --- Notifications ---

export async function getNotifications(): Promise<NotificationRecord[]> {
  return fetchApi<NotificationRecord[]>('/notifications');
}

export async function markNotificationsRead(): Promise<NotificationRecord[]> {
  return fetchApi<NotificationRecord[]>('/notifications', { method: 'PUT' });
}

// --- Push prefs ---

export async function getPushPrefs(): Promise<NotifyPrefs> {
  return fetchApi<NotifyPrefs>('/push/prefs');
}

export async function updatePushPrefs(prefs: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  return fetchApi<NotifyPrefs>('/push/prefs', {
    method: 'PATCH',
    body: JSON.stringify(prefs),
  });
}

// --- Claim/unclaim expense item helper ---

export async function claimExpenseItem(
  expense: Expense,
  itemId: string,
  memberId: string,
  claim: boolean,
): Promise<Expense> {
  if (!expense.items) {
    throw new Error('Expense has no items');
  }

  const updatedItems = expense.items.map((item) => {
    if (item.id === itemId) {
      return {
        ...item,
        memberId: claim ? memberId : undefined,
      };
    }
    return item;
  });

  const memberAmounts = new Map<string, number>();
  let assignedTotal = 0;

  for (const item of updatedItems) {
    if (item.memberId) {
      const current = memberAmounts.get(item.memberId) || 0;
      memberAmounts.set(item.memberId, current + item.amount);
      assignedTotal += item.amount;
    }
  }

  const payerRemainder = expense.amount - assignedTotal;
  const payerAmount = memberAmounts.get(expense.paidBy) || 0;
  memberAmounts.set(expense.paidBy, payerAmount + payerRemainder);

  const now = new Date().toISOString();
  const updatedSplits: typeof expense.splits = [];

  for (const [splitMemberId, amount] of memberAmounts.entries()) {
    if (amount === 0 && splitMemberId !== expense.paidBy) {
      continue;
    }

    const existingSplit = expense.splits.find((s) => s.memberId === splitMemberId);
    const isPayer = splitMemberId === expense.paidBy;
    const isClaimer = splitMemberId === memberId;

    let signedOff: boolean;
    let signedAt: string | undefined;

    if (isPayer || isClaimer) {
      signedOff = true;
      signedAt = now;
    } else if (existingSplit) {
      signedOff = existingSplit.signedOff;
      signedAt = existingSplit.signedAt;
    } else {
      signedOff = false;
    }

    updatedSplits.push({
      memberId: splitMemberId,
      value: amount,
      amount: amount,
      signedOff,
      signedAt,
    });
  }

  return updateExpense(expense.id, {
    items: updatedItems,
    splits: updatedSplits,
    splitType: 'exact',
  });
}
