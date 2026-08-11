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
import { notifyMembers as notifyTelegram, sendDebouncedEditNotification, createCallbackData } from '../utils/telegram';
import { acquireLockWithRetry } from '../utils/locks';

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

function structuralFieldsChanged(before: Expense, after: Expense): boolean {
  return (
    before.amount !== after.amount ||
    before.paidBy !== after.paidBy ||
    before.splitType !== after.splitType ||
    (before.createdBy ?? before.paidBy) !== (after.createdBy ?? after.paidBy) ||
    before.description !== after.description
  );
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

export const onRequestPut: PagesFunction<AuthEnv> = async (context) => {
  try {
    const ctx = await requireGroup(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const { group, member } = ctx;

    const id = context.params.id as string;
    const updates = (await context.request.json()) as Partial<Expense>;

    // The whole group's expenses live in one KV record; serialize the
    // read-modify-write or concurrent updates (e.g. several members signing
    // off at once) silently overwrite each other.
    const lock = await acquireLockWithRetry(context.env, `expenses::${group.id}`);
    if (!lock) {
      return Response.json(
        { success: false, error: 'Another update is in progress — please retry' },
        { status: 409 },
      );
    }
    try {
      const expenses = (await getExpenses(context.env, group.id)) as Expense[];

      const index = expenses.findIndex((e) => e.id === id);
      if (index === -1) {
        return Response.json(
          { success: false, error: 'Expense not found' },
          { status: 404 },
        );
      }

      const before = expenses[index];
      const merged: Expense = {
        ...before,
        ...updates,
        id: before.id,
        createdAt: before.createdAt,
        // History is server-owned — never accept it from the client.
        history: before.history,
      };
      const structural = structuralFieldsChanged(before, merged);
      if (structural && !canEditExpenseStructurally(group, before, member)) {
        return Response.json(
          { success: false, error: 'Only the creator or a group admin can change this expense' },
          { status: 403 },
        );
      }
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

      expenses[index] = merged;
      const updatedExpense = merged;
      await saveExpenses(context.env, group.id, expenses);

      const isDeleted = updatedExpense.tags?.includes('deleted');
      context.waitUntil(
        sendEditNotification(context.env, group, updatedExpense, member.id, isDeleted ? 'removed' : 'updated'),
      );

      return Response.json({ success: true, data: updatedExpense });
    } finally {
      await lock.release();
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

    const lock = await acquireLockWithRetry(context.env, `expenses::${group.id}`);
    if (!lock) {
      return Response.json(
        { success: false, error: 'Another update is in progress — please retry' },
        { status: 409 },
      );
    }
    try {
      const expenses = (await getExpenses(context.env, group.id)) as Expense[];

      const index = expenses.findIndex((e) => e.id === id);
      if (index === -1) {
        return Response.json(
          { success: false, error: 'Expense not found' },
          { status: 404 },
        );
      }

      const deletedExpense = expenses[index];
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
      expenses.splice(index, 1);
      await saveExpenses(context.env, group.id, expenses);

      context.waitUntil(sendEditNotification(context.env, group, deletedExpense, member.id, 'removed'));

      return Response.json({ success: true });
    } finally {
      await lock.release();
    }
  } catch (error) {
    return Response.json(
      { success: false, error: 'Failed to delete expense' },
      { status: 500 },
    );
  }
};
