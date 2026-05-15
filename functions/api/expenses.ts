import type { AuthEnv } from './types/auth';
import { requireGroup } from './utils/session';
import {
  getExpenses,
  saveExpenses,
  GroupRecord,
  findMember,
  memberIdsToUserIds,
  validateExpenseInput,
  type Expense,
} from './utils/groups';
import { notifyMembers as notifyPush } from './utils/web-push';
import { notifyMembers as notifyTelegram, sendTelegramNotification, createCallbackData } from './utils/telegram';

function getMemberName(group: GroupRecord, id: string): string {
  return findMember(group, id)?.name ?? id;
}

function formatAmount(amount: number, currency: string): string {
  return `${amount.toLocaleString('vi-VN')} ${currency}`;
}

async function sendExpenseNotification(
  env: AuthEnv,
  group: GroupRecord,
  expense: Expense,
  action: 'added' | 'updated',
): Promise<void> {
  const involved = new Set<string>();
  if (expense.splitType === 'group') {
    // Group-mode persists no splits; everyone currently in the group is on the hook.
    for (const m of group.members) involved.add(m.id);
  } else {
    for (const split of expense.splits) involved.add(split.memberId);
  }
  involved.add(expense.paidBy);

  const creatorId = expense.createdBy ?? expense.paidBy;
  if (expense.createdBy) involved.delete(expense.createdBy);

  if (involved.size === 0) return;

  const currency = group.currency;
  const creatorName = getMemberName(group, creatorId);
  const involvedIds = [...involved];

  const isSettlement = expense.splitType === 'settlement';
  const title = isSettlement ? 'Settlement' : 'Expense';
  const body =
    action === 'added'
      ? isSettlement
        ? `${creatorName} recorded a settlement: ${expense.description}`
        : `${creatorName} added "${expense.description}" (${expense.amount})`
      : `${creatorName} updated "${expense.description}"`;

  try {
    await notifyPush(env, group, involvedIds, {
      title,
      body,
      url: `/tx/${expense.id}`,
      tag: `expense-${expense.id}`,
    }, isSettlement ? 'settlementRequest' : (action === 'added' ? 'newExpense' : 'expenseEdited'));
  } catch (err) {
    console.error('Failed to send push notifications:', err);
  }

  try {
    if (isSettlement) {
      const debtorSplit = expense.splits.find((s) => s.memberId !== expense.paidBy);
      if (debtorSplit) {
        const debtor = findMember(group, debtorSplit.memberId);
        if (debtor?.userId) {
          const payerName = getMemberName(group, expense.paidBy);
          const recipientName = debtor.name;
          const cbAccept = await createCallbackData(env, 'settle_accept', group.id, expense.id);
          const cbReject = await createCallbackData(env, 'settle_reject', group.id, expense.id);
          await sendTelegramNotification(
            debtor.userId,
            'settlementRequest',
            `🤝 <b>Settlement request</b>\n\n<b>${payerName}</b> made a settlement payment to <b>${recipientName}</b>\n💰 Amount: <b>${formatAmount(expense.amount, currency)}</b>\n📝 Note: ${expense.description}\n\nPlease confirm that you received the money.`,
            env,
            {
              inline_keyboard: [
                [
                  { text: '✅ Confirm receipt', callback_data: cbAccept },
                  { text: '❌ Reject', callback_data: cbReject },
                ],
              ],
            },
          );
        }
      }
    } else {
      const payerName = getMemberName(group, expense.paidBy);
      const isGroupMode = expense.splitType === 'group';
      const splitsDetail = isGroupMode
        ? `  • Split across the whole group (${group.members.length} member${group.members.length === 1 ? '' : 's'})`
        : expense.splits
            .map((s) => `  • ${getMemberName(group, s.memberId)}: ${formatAmount(s.amount, currency)}`)
            .join('\n');
      const memberIds = isGroupMode
        ? group.members.map((m) => m.id)
        : expense.splits.map((s) => s.memberId);
      const userIds = memberIdsToUserIds(group, memberIds);
      const excludeUserId = findMember(group, creatorId)?.userId ?? '';
      // Group-mode doesn't require per-member sign-off, so omit the confirm button.
      let replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] } | undefined;
      if (!isGroupMode) {
        const cbSignoff = await createCallbackData(env, 'signoff', group.id, expense.id);
        replyMarkup = { inline_keyboard: [[{ text: '✅ Confirm', callback_data: cbSignoff }]] };
      }
      await notifyTelegram(
        userIds,
        excludeUserId,
        'newExpense',
        `💸 <b>New expense</b>\n\n📌 ${expense.description}\n👤 Paid by: <b>${payerName}</b>\n💰 Total: <b>${formatAmount(expense.amount, currency)}</b>\n\n<b>Each member's share:</b>\n${splitsDetail}`,
        env,
        replyMarkup,
      );
    }
  } catch (err) {
    console.error('Failed to send Telegram notifications:', err);
  }
}

export const onRequestGet: PagesFunction<AuthEnv> = async (context) => {
  try {
    const ctx = await requireGroup(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const expenses = await getExpenses(context.env, ctx.group.id);
    return Response.json({ success: true, data: expenses });
  } catch (error) {
    return Response.json(
      { success: false, error: 'Failed to fetch expenses' },
      { status: 500 },
    );
  }
};

export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  try {
    const ctx = await requireGroup(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const { group, member } = ctx;

    const expense = (await context.request.json()) as Omit<Expense, 'id' | 'createdAt'>;
    const validationError = validateExpenseInput(group, expense);
    if (validationError) {
      return Response.json({ success: false, error: validationError }, { status: 400 });
    }

    const expenses = (await getExpenses(context.env, group.id)) as Expense[];

    const newExpense: Expense = {
      ...expense,
      createdBy: expense.createdBy ?? member.id,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    expenses.push(newExpense);
    await saveExpenses(context.env, group.id, expenses);

    context.waitUntil(sendExpenseNotification(context.env, group, newExpense, 'added'));

    return Response.json({ success: true, data: newExpense });
  } catch (error) {
    return Response.json(
      { success: false, error: 'Failed to create expense' },
      { status: 500 },
    );
  }
};
