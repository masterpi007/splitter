import type { AuthEnv } from '../types/auth';
import { requireGroup } from '../utils/session';
import {
  getExpenses,
  saveExpenses,
  GroupRecord,
  GroupMember,
  findMember,
  memberIdsToUserIds,
  validateExpenseInput,
  isAdmin,
  type Expense,
} from '../utils/groups';
import { notifyMembers as notifyPush } from '../utils/web-push';
import { notifyMembers as notifyTelegram, sendDebouncedEditNotification, createCallbackData, sendTelegramNotification } from '../utils/telegram';
import { loadExpense, writeExpense, deleteExpenseRow } from '../utils/db';

// Fields that rewrite the "truth" of an expense (amount, attribution). Only
// the original creator or a group admin can change these; anyone else can
// still sign off their own split, claim items, or adjust descriptive tags.
// Diff the fields worth showing in the activity timeline. Sign-off flips are
// deliberately excluded — the client derives those from sign-off timestamps.
function diffExpenseForHistory(before: Expense, after: Expense) {
  const changes: { field: string; from?: unknown; to?: unknown }[] = [];
  const scalarFields = ['description', 'amount', 'paidBy', 'splitType', 'discount', 'discountType', 'receiptDate'] as const;
  for (const f of scalarFields) {
    if (before[f] !== after[f] && (before[f] !== undefined || after[f] !== undefined)) {
      changes.push({ field: f, from: before[f], to: after[f] });
    }
  }
  // Per-member share changes (skip group mode — its splits are ephemeral).
  if (after.splitType !== 'group') {
    const beforeAmounts = new Map((before.splits ?? []).map((s) => [s.memberId, s.amount]));
    const afterAmounts = new Map((after.splits ?? []).map((s) => [s.memberId, s.amount]));
    const ids = new Set([...beforeAmounts.keys(), ...afterAmounts.keys()]);
    for (const id of ids) {
      const b = beforeAmounts.get(id);
      const a = afterAmounts.get(id);
      if (b !== a) changes.push({ field: `split:${id}`, from: b, to: a });
    }
  }
  const wasDeleted = before.tags?.includes('deleted') ?? false;
  const nowDeleted = after.tags?.includes('deleted') ?? false;
  if (wasDeleted !== nowDeleted) changes.push({ field: nowDeleted ? 'deleted' : 'restored' });
  return changes;
}

const HISTORY_CAP = 50;

// Accepting your share goes through the same PUT as a real edit, so without
// this every sign-off notified the whole group that the expense was
// "updated". True when nothing changed except acceptance state.
function isAcceptanceOnlyChange(before: Expense, after: Expense): boolean {
  if (diffExpenseForHistory(before, after).length > 0) return false;

  const beforeItems = ((before as any).items ?? []) as { id: string; description?: string; amount: number; memberId?: string }[];
  const afterItems = ((after as any).items ?? []) as typeof beforeItems;
  if (beforeItems.length !== afterItems.length) return false;
  const itemsById = new Map(beforeItems.map((i) => [i.id, i]));
  for (const item of afterItems) {
    const b = itemsById.get(item.id);
    if (!b) return false;
    if (b.amount !== item.amount || b.description !== item.description || b.memberId !== item.memberId) {
      return false;
    }
  }

  const beforeTags = [...(before.tags ?? [])].sort().join(',');
  const afterTags = [...(after.tags ?? [])].sort().join(',');
  return beforeTags === afterTags;
}

function structuralFieldsChanged(before: Expense, after: Expense): boolean {
  return (
    before.amount !== after.amount ||
    before.paidBy !== after.paidBy ||
    before.splitType !== after.splitType ||
    (before.createdBy ?? before.paidBy) !== (after.createdBy ?? after.paidBy) ||
    before.description !== after.description
  );
}

// What a member who is neither creator nor admin may change on someone
// else's expense. Previously the server only guarded "structural" fields, so
// any group member could accept another member's split or move amounts
// between splits — sign-offs are the app's record of agreement, so they have
// to be forgeable only by their owner.
//
// Returns an error message, or null when every change is permitted.
function authorizeParticipantEdit(
  before: Expense,
  after: Expense,
  actorId: string,
): string | null {
  const frozen = [
    'description', 'amount', 'paidBy', 'createdBy', 'splitType',
    'discount', 'discountType', 'receiptUrl', 'receiptDate',
  ] as const;
  for (const f of frozen) {
    if (before[f] !== after[f]) return `Only the creator or a group admin can change ${f}`;
  }

  // Splits: the member set and every amount stay put; a member may flip only
  // their own acceptance.
  const beforeSplits = new Map((before.splits ?? []).map((s) => [s.memberId, s]));
  const afterSplits = new Map((after.splits ?? []).map((s) => [s.memberId, s]));
  if (beforeSplits.size !== afterSplits.size) {
    return 'Only the creator or a group admin can change who this is split between';
  }
  for (const [memberId, a] of afterSplits) {
    const b = beforeSplits.get(memberId);
    if (!b) return 'Only the creator or a group admin can change who this is split between';
    if (b.amount !== a.amount || b.value !== a.value) {
      return 'Only the creator or a group admin can change split amounts';
    }
    const acceptanceChanged = b.signedOff !== a.signedOff || b.signedAt !== a.signedAt;
    if (acceptanceChanged && memberId !== actorId) {
      return 'You can only accept your own share';
    }
  }

  // Group-mode ledger: the actor may add or remove their own entry only.
  const beforeSigned = new Set((before.signedOffBy ?? []).map((s) => s.memberId));
  const afterSigned = new Set((after.signedOffBy ?? []).map((s) => s.memberId));
  for (const id of new Set([...beforeSigned, ...afterSigned])) {
    if (id !== actorId && beforeSigned.has(id) !== afterSigned.has(id)) {
      return 'You can only accept your own share';
    }
  }

  // Items: amounts are fixed; a member may claim an unassigned item, release
  // one of their own, and retitle their own.
  const beforeItems = new Map(
    ((before as any).items ?? []).map((i: any) => [i.id, i]),
  ) as Map<string, any>;
  const afterItems = (after as any).items ?? [];
  if (beforeItems.size !== afterItems.length) {
    return 'Only the creator or a group admin can add or remove items';
  }
  for (const item of afterItems) {
    const b = beforeItems.get(item.id);
    if (!b) return 'Only the creator or a group admin can add or remove items';
    if (b.amount !== item.amount) {
      return 'Only the creator or a group admin can change item amounts';
    }
    if (b.memberId !== item.memberId) {
      const claiming = !b.memberId && item.memberId === actorId;
      const releasing = b.memberId === actorId && !item.memberId;
      if (!claiming && !releasing) return 'You can only claim or release your own items';
    }
    if (b.description !== item.description && b.memberId !== actorId) {
      return 'You can only rename your own items';
    }
  }

  // Tags stay editable by any participant — they carry no financial meaning.
  return null;
}

function canEditExpenseStructurally(
  group: GroupRecord,
  expense: Expense,
  actor: GroupMember,
): boolean {
  const creatorId = expense.createdBy ?? expense.paidBy;
  return creatorId === actor.id || isAdmin(group, actor.id);
}

function getMemberName(group: GroupRecord, id: string): string {
  return findMember(group, id)?.name ?? id;
}

function formatAmount(amount: number, currency: string): string {
  return `${amount.toLocaleString('vi-VN')} ${currency}`;
}

async function sendEditNotification(
  env: AuthEnv,
  group: GroupRecord,
  expense: Expense,
  editorMemberId: string | null,
  action: 'updated' | 'removed',
): Promise<void> {
  const involved = new Set<string>();
  if (expense.splitType === 'group') {
    // Group-mode has no persisted splits; loop current members.
    for (const m of group.members) involved.add(m.id);
  } else {
    for (const split of expense.splits) involved.add(split.memberId);
  }
  involved.add(expense.paidBy);
  if (editorMemberId) involved.delete(editorMemberId);
  if (involved.size === 0) return;

  const currency = group.currency;
  const editorName = editorMemberId ? getMemberName(group, editorMemberId) : 'Someone';
  const involvedIds = [...involved];

  const title = action === 'removed' ? 'Expense Removed' : 'Expense Updated';
  const body = action === 'removed'
    ? `${editorName} removed "${expense.description}"`
    : `${editorName} updated "${expense.description}"`;

  try {
    await notifyPush(env, group, involvedIds, {
      title,
      body,
      url: action === 'removed' ? '/expenses' : `/tx/${expense.id}`,
      tag: `expense-${expense.id}`,
    }, action === 'removed' ? 'expenseDeleted' : 'expenseEdited');
  } catch (err) {
    console.error('Failed to send push notifications:', err);
  }

  try {
    const editorUserId = editorMemberId ? (findMember(group, editorMemberId)?.userId ?? '') : '';
    if (action === 'updated') {
      const payerName = getMemberName(group, expense.paidBy);
      const splitsDetail = expense.splits
        .map((s) => `  • ${getMemberName(group, s.memberId)}: ${formatAmount(s.amount, currency)}`)
        .join('\n');
      const userIds = memberIdsToUserIds(group, expense.splits.map((s) => s.memberId));
      const cbSignoff = await createCallbackData(env, 'signoff', group.id, expense.id);
      await sendDebouncedEditNotification(
        expense.id,
        userIds,
        editorUserId,
        `✏️ <b>Expense updated</b>\n\n📌 ${expense.description}\n👤 Paid by: <b>${payerName}</b>\n✍️ Edited by: <b>${editorName}</b>\n💰 Total: <b>${formatAmount(expense.amount, currency)}</b>\n\n<b>Each member's share:</b>\n${splitsDetail}\n\n⚠️ Please confirm again.`,
        env,
        {
          inline_keyboard: [
            [{ text: '✅ Confirm again', callback_data: cbSignoff }],
          ],
        },
      );
    } else {
      const userIds = memberIdsToUserIds(group, expense.splits.map((s) => s.memberId));
      await notifyTelegram(
        userIds,
        editorUserId,
        'expenseDeleted',
        `🗑️ <b>Expense deleted</b>\n\n📌 ${expense.description}\n💰 Total: <b>${formatAmount(expense.amount, currency)}</b>\n🙍 Deleted by: <b>${editorName}</b>`,
        env,
      );
    }
  } catch (err) {
    console.error('Failed to send Telegram notifications:', err);
  }
}

// A settlement is "the money arrived" rather than "I acknowledge a bill", so
// its confirmation is the one acceptance worth notifying — and only the payer,
// who is waiting to know. The Telegram confirm button already did this; this
// covers confirming in the app.
async function sendSettlementAccepted(
  env: AuthEnv,
  group: GroupRecord,
  expense: Expense,
  receiverMemberId: string,
): Promise<void> {
  const payer = findMember(group, expense.paidBy);
  if (!payer || payer.id === receiverMemberId) return;
  const receiverName = getMemberName(group, receiverMemberId);
  const body = `${receiverName} confirmed receiving your payment`;

  try {
    await notifyPush(env, group, [payer.id], {
      title: 'Settlement confirmed',
      body,
      url: `/tx/${expense.id}`,
      tag: `expense-${expense.id}`,
    }, 'settlementAccepted');
  } catch (err) {
    console.error('Failed to send push notifications:', err);
  }

  try {
    if (payer.userId) {
      await sendTelegramNotification(
        payer.userId,
        'settlementAccepted',
        `✅ <b>${receiverName}</b> confirmed receiving your payment\n\n💰 Amount: <b>${formatAmount(expense.amount, group.currency)}</b>\n📝 Note: ${expense.description}`,
        env,
      );
    }
  } catch (err) {
    console.error('Failed to send Telegram notifications:', err);
  }
}

// True when this edit is the settlement recipient confirming receipt.
function isSettlementConfirmation(before: Expense, after: Expense, actorId: string): boolean {
  if (after.splitType !== 'settlement') return false;
  const was = before.splits?.find((s) => s.memberId === actorId);
  const now = after.splits?.find((s) => s.memberId === actorId);
  return !!was && !!now && !was.signedOff && now.signedOff;
}

export const onRequestPut: PagesFunction<AuthEnv> = async (context) => {
  try {
    const ctx = await requireGroup(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const { group, member } = ctx;

    const id = context.params.id as string;
    const updates = (await context.request.json()) as Partial<Expense>;

    {
      const before = await loadExpense(context.env, group.id, id);
      if (!before) {
        return Response.json(
          { success: false, error: 'Expense not found' },
          { status: 404 },
        );
      }

      const merged: Expense = {
        ...before,
        ...updates,
        id: before.id,
        createdAt: before.createdAt,
        // History is server-owned — never accept it from the client.
        history: before.history,
      };
      const privileged = canEditExpenseStructurally(group, before, member);
      if (!privileged) {
        const denied = authorizeParticipantEdit(before, merged, member.id);
        if (denied) {
          return Response.json({ success: false, error: denied }, { status: 403 });
        }
      }
      const structural = structuralFieldsChanged(before, merged);
      if (structural) {
        const validationError = validateExpenseInput(group, merged);
        if (validationError) {
          return Response.json({ success: false, error: validationError }, { status: 400 });
        }
      }
      const historyChanges = diffExpenseForHistory(before, merged);
      if (historyChanges.length > 0) {
        merged.history = [
          ...(before.history ?? []),
          { at: new Date().toISOString(), by: member.id, changes: historyChanges },
        ].slice(-HISTORY_CAP);
      }

      // Writes only this expense's rows, so two members accepting different
      // transactions at the same time can no longer clobber each other — the
      // reason the advisory lock existed.
      const updatedExpense = merged;
      await writeExpense(context.env, group.id, merged);

      // Creates, edits and deletes are worth interrupting people for;
      // someone accepting their own share is not.
      if (isAcceptanceOnlyChange(before, merged)) {
        if (isSettlementConfirmation(before, merged, member.id)) {
          context.waitUntil(
            sendSettlementAccepted(context.env, group, merged, member.id),
          );
        }
      } else {
        const isDeleted = updatedExpense.tags?.includes('deleted');
        context.waitUntil(
          sendEditNotification(context.env, group, updatedExpense, member.id, isDeleted ? 'removed' : 'updated'),
        );
      }

      return Response.json({ success: true, data: updatedExpense });
    }
  } catch (error) {
    return Response.json(
      { success: false, error: 'Failed to update expense' },
      { status: 500 },
    );
  }
};

export const onRequestDelete: PagesFunction<AuthEnv> = async (context) => {
  try {
    const ctx = await requireGroup(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const { group, member } = ctx;

    const id = context.params.id as string;

    {
      const deletedExpense = await loadExpense(context.env, group.id, id);
      if (!deletedExpense) {
        return Response.json(
          { success: false, error: 'Expense not found' },
          { status: 404 },
        );
      }
      // Group admins may delete any expense; the creator or the payer may
      // delete their own.
      const creatorId = deletedExpense.createdBy ?? deletedExpense.paidBy;
      const mayDelete =
        isAdmin(group, member.id) ||
        creatorId === member.id ||
        deletedExpense.paidBy === member.id;
      if (!mayDelete) {
        return Response.json(
          { success: false, error: 'Only the creator, the payer, or a group admin can delete this expense' },
          { status: 403 },
        );
      }
      await deleteExpenseRow(context.env, deletedExpense.id);

      context.waitUntil(sendEditNotification(context.env, group, deletedExpense, member.id, 'removed'));

      return Response.json({ success: true });
    }
  } catch (error) {
    return Response.json(
      { success: false, error: 'Failed to delete expense' },
      { status: 500 },
    );
  }
};
