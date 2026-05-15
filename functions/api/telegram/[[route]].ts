import { Bot, webhookCallback } from 'grammy';
import {
  KV_KEYS,
  DEFAULT_NOTIFY_PREFS,
  TELEGRAM_CONNECT_TTL_SECONDS,
} from '../types/auth';
import type { TelegramData, TelegramConnectToken, NotifyPrefs, AuthEnv } from '../types/auth';
import { editTelegramMessage, sendTelegramNotification, createCallbackData, resolveCallback } from '../utils/telegram';
import { getTokenFromCookies, verifySession } from '../utils/jwt';
import {
  LEGACY_GROUP_ID,
  getExpenses as getGroupExpenses,
  saveExpenses as saveGroupExpenses,
  getGroup as getGroupRecord,
  findMember,
} from '../utils/groups';
import { getMemberships } from '../utils/users';

interface Env {
  SPLITTER_KV: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  JWT_SECRET: string;
}

// ── JWT helper ─────────────────────────────────────────────────────────────

// Resolve the authenticated user's id. Telegram bindings live on the User
// (one Telegram account per person, applied across all groups they're in).
async function getUserIdFromJWT(request: Request, env: Env): Promise<string | null> {
  const token = getTokenFromCookies(request);
  if (!token) return null;
  const session = await verifySession(env, token);
  return session?.userId ?? null;
}

// ── Route helpers ──────────────────────────────────────────────────────────

function getRoutePath(request: Request): string {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  return parts[parts.length - 1] ?? '';
}

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleConnect(request: Request, env: Env): Promise<Response> {
  const userId = await getUserIdFromJWT(request, env);
  if (!userId) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const token = crypto.randomUUID();
  const payload: TelegramConnectToken = {
    userId,
    expiresAt: new Date(Date.now() + TELEGRAM_CONNECT_TTL_SECONDS * 1000).toISOString(),
  };
  await env.SPLITTER_KV.put(KV_KEYS.telegramConnect(token), JSON.stringify(payload), {
    expirationTtl: TELEGRAM_CONNECT_TTL_SECONDS,
  });

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
  const me = await res.json() as { result?: { username?: string } };
  const botUsername = me.result?.username ?? 'bot';

  return Response.json({
    success: true,
    data: { deepLink: `https://t.me/${botUsername}?start=${token}` },
  });
}

async function handleDisconnect(request: Request, env: Env): Promise<Response> {
  const userId = await getUserIdFromJWT(request, env);
  if (!userId) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const data = await env.SPLITTER_KV.get<TelegramData>(KV_KEYS.telegram(userId), 'json');
  if (data) await env.SPLITTER_KV.delete(KV_KEYS.telegramChatId(data.chatId));
  await env.SPLITTER_KV.delete(KV_KEYS.telegram(userId));

  return Response.json({ success: true });
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  const userId = await getUserIdFromJWT(request, env);
  if (!userId) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const data = await env.SPLITTER_KV.get<TelegramData>(KV_KEYS.telegram(userId), 'json');
  return Response.json({
    success: true,
    data: { connected: !!data, notifyPrefs: data?.notifyPrefs ?? null, telegramName: data?.telegramName ?? null },
  });
}

async function handlePreferences(request: Request, env: Env): Promise<Response> {
  const userId = await getUserIdFromJWT(request, env);
  if (!userId) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const updates = await request.json() as Partial<NotifyPrefs>;
  const data = await env.SPLITTER_KV.get<TelegramData>(KV_KEYS.telegram(userId), 'json');
  if (!data) return Response.json({ success: false, error: 'Not connected' }, { status: 400 });

  const updated: TelegramData = {
    ...data,
    notifyPrefs: { ...DEFAULT_NOTIFY_PREFS, ...data.notifyPrefs, ...updates },
  };
  await env.SPLITTER_KV.put(KV_KEYS.telegram(userId), JSON.stringify(updated));

  return Response.json({ success: true, data: { notifyPrefs: updated.notifyPrefs } });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // /start {token} — connect flow
  bot.command('start', async (ctx) => {
    const token = ctx.match?.trim();
    if (!token) {
      await ctx.reply('Hello! Connect your account from the app settings.');
      return;
    }

    const connectData = await env.SPLITTER_KV.get<TelegramConnectToken>(
      KV_KEYS.telegramConnect(token), 'json',
    );
    if (!connectData || new Date(connectData.expiresAt) < new Date()) {
      await ctx.reply('❌ This link is expired or invalid. Please try again from the app.');
      return;
    }

    const chatId = String(ctx.chat.id);
    const telegramName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || ctx.from?.username || 'Unknown';

    // Enforce 1:1 — if this Telegram account is already linked to another user, disconnect it first
    const existingUserId = await env.SPLITTER_KV.get(KV_KEYS.telegramChatId(chatId));
    if (existingUserId && existingUserId !== connectData.userId) {
      await env.SPLITTER_KV.delete(KV_KEYS.telegram(existingUserId));
    }

    // Detect a rebind: the user previously linked a different chat. We must
    // order the writes so that at no point does the stale-entry cleanup in
    // sendTelegramNotification (which deletes telegram(userId) when the
    // forward mapping doesn't match) observe a half-migrated state that
    // could wipe the freshly-connected chat.
    //
    // Order:
    //   1) put telegramChatId(NEW_chatId) → userId   (forward mapping in place)
    //   2) put telegram(userId) → NEW data            (reverse mapping updated)
    //   3) delete telegramChatId(OLD_chatId)          (kill the stale forward)
    // Between 1 and 2 a concurrent sender still reads the OLD reverse, whose
    // OLD forward is still live — the worst case is a notification to the
    // old chat, never data loss.
    const existingData = await env.SPLITTER_KV.get<TelegramData>(KV_KEYS.telegram(connectData.userId), 'json');

    const telegramData: TelegramData = {
      chatId,
      telegramName,
      connectedAt: new Date().toISOString(),
      notifyPrefs: DEFAULT_NOTIFY_PREFS,
    };
    await env.SPLITTER_KV.put(KV_KEYS.telegramChatId(chatId), connectData.userId);
    await env.SPLITTER_KV.put(KV_KEYS.telegram(connectData.userId), JSON.stringify(telegramData));
    if (existingData && existingData.chatId !== chatId) {
      await env.SPLITTER_KV.delete(KV_KEYS.telegramChatId(existingData.chatId));
    }
    await env.SPLITTER_KV.delete(KV_KEYS.telegramConnect(token));

    // Show the user's first-group display name in the confirmation for a personal touch.
    const memberships = await getMemberships(env as unknown as AuthEnv, connectData.userId);
    let displayName = connectData.userId;
    if (memberships.length > 0) {
      const grp = await getGroupRecord(env as unknown as AuthEnv, memberships[0].groupId);
      const me = grp ? findMember(grp, memberships[0].memberId) : undefined;
      if (me) displayName = me.name;
    }
    await ctx.reply(`✅ Connected successfully! Notifications for <b>${displayName}</b> will be sent here.`, { parse_mode: 'HTML' });
  });

  // Callback query — button taps.
  // Callback data format: "<action>:<groupId>:<expenseId>". Older messages sent
  // before multi-group support used "<action>:<expenseId>" — those fall back to
  // the legacy 1matrix group so existing in-flight notifications still work.
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = String(ctx.callbackQuery.from.id);
    const messageId = ctx.callbackQuery.message?.message_id;

    const userId = await env.SPLITTER_KV.get(KV_KEYS.telegramChatId(chatId));
    if (!userId) {
      await ctx.answerCallbackQuery({ text: 'Session expired. Please reconnect.' });
      return;
    }

    const resolved = await resolveCallback(env, data, LEGACY_GROUP_ID);
    if (!resolved) {
      await ctx.answerCallbackQuery({ text: 'Invalid or expired action.' });
      return;
    }
    const { action, groupId, expenseId } = resolved;

    if (action === 'signoff') {
      await ctx.answerCallbackQuery();
      const cbYes = await createCallbackData(env, 'yes_signoff', groupId, expenseId);
      const cbNo = await createCallbackData(env, 'no', groupId, expenseId);
      await ctx.editMessageReplyMarkup({
        reply_markup: { inline_keyboard: [[
          { text: '✅ Confirm', callback_data: cbYes },
          { text: '❌ Cancel', callback_data: cbNo },
        ]] },
      });
    } else if (action === 'yes_signoff') {
      await handleSignOff(ctx, userId, groupId, expenseId, chatId, messageId, env);
    } else if (action === 'settle_accept') {
      await ctx.answerCallbackQuery();
      const cbYes = await createCallbackData(env, 'yes_settle_accept', groupId, expenseId);
      const cbNo = await createCallbackData(env, 'no', groupId, expenseId);
      await ctx.editMessageReplyMarkup({
        reply_markup: { inline_keyboard: [[
          { text: '✅ Confirm receipt', callback_data: cbYes },
          { text: '❌ Cancel', callback_data: cbNo },
        ]] },
      });
    } else if (action === 'yes_settle_accept') {
      await handleSettleAccept(ctx, userId, groupId, expenseId, chatId, messageId, env);
    } else if (action === 'no') {
      await ctx.answerCallbackQuery({ text: 'Cancelled.' });
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
      await ctx.reply('❎ Cancelled.');
    } else if (action === 'settle_reject') {
      await ctx.answerCallbackQuery({ text: '❌ Rejected.' });
      await processRejection(userId, groupId, expenseId, chatId, messageId, ctx, env);
    }
  });

  const handler = webhookCallback(bot, 'cloudflare-mod');
  return handler(request);
}

// ── Action processors ──────────────────────────────────────────────────────

type Expense = {
  id: string;
  paidBy: string;
  description: string;
  amount: number;
  splits: Array<{ memberId: string; amount: number; signedOff: boolean; signedAt?: string }>;
};

function formatAmount(amount: number, currency: string): string {
  return `${amount.toLocaleString('vi-VN')} ${currency}`;
}

// Resolve the caller's memberId within the target group via their user
// memberships. Telegram itself only knows a userId (global); the expense
// split rows are keyed by per-group memberId.
async function resolveCallerMemberId(
  env: Env,
  userId: string,
  groupId: string,
): Promise<string | null> {
  const memberships = await getMemberships(env as unknown as AuthEnv, userId);
  return memberships.find((m) => m.groupId === groupId)?.memberId ?? null;
}

// Resolve the payer's userId in a group for notifying them after an action.
async function userIdForMember(
  env: Env,
  groupId: string,
  memberId: string,
): Promise<string | null> {
  const group = await getGroupRecord(env as unknown as AuthEnv, groupId);
  if (!group) return null;
  return findMember(group, memberId)?.userId ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CallbackCtx = any;

async function handleSignOff(
  ctx: CallbackCtx,
  userId: string,
  groupId: string,
  expenseId: string,
  chatId: string,
  messageId: number | undefined,
  env: Env,
): Promise<void> {
  const group = await getGroupRecord(env as unknown as AuthEnv, groupId);
  if (!group) { await ctx.answerCallbackQuery({ text: 'Group not found.' }); return; }

  const memberId = await resolveCallerMemberId(env, userId, groupId);
  if (!memberId) { await ctx.answerCallbackQuery({ text: 'You are not a member of this group.' }); return; }

  const expenses = (await getGroupExpenses(env as unknown as AuthEnv, groupId)) as Expense[];
  const expense = expenses.find((e) => e.id === expenseId);
  if (!expense) { await ctx.answerCallbackQuery({ text: 'Expense not found.' }); return; }

  const split = expense.splits.find((s) => s.memberId === memberId);
  if (!split) { await ctx.answerCallbackQuery({ text: 'You are not part of this expense.' }); return; }

  split.signedOff = true;
  split.signedAt = new Date().toISOString();
  await saveGroupExpenses(env as unknown as AuthEnv, groupId, expenses);

  const currency = group.currency;
  const payerName = findMember(group, expense.paidBy)?.name ?? expense.paidBy;
  const myName = findMember(group, memberId)?.name ?? memberId;
  const myShare = formatAmount(split.amount, currency);
  const totalConfirmed = expense.splits.filter((s) => s.signedOff).length;
  const totalSplits = expense.splits.length;

  await ctx.answerCallbackQuery({ text: '✅ Confirmed!' });
  if (messageId) await editTelegramMessage(
    chatId, messageId,
    `✅ <b>You confirmed this expense</b>\n\n📌 ${expense.description}\n👤 Paid by: <b>${payerName}</b>\n💰 Total: <b>${formatAmount(expense.amount, currency)}</b>\n💵 Your share: <b>${myShare}</b>\n\n✅ Confirmed: ${totalConfirmed}/${totalSplits} members`,
    env,
  );

  const payerUserId = await userIdForMember(env, groupId, expense.paidBy);
  if (payerUserId) {
    await sendTelegramNotification(
      payerUserId,
      'expenseEdited',
      `✅ <b>${myName}</b> confirmed expense\n\n📌 ${expense.description}\n💵 Their share: <b>${myShare}</b>\n\n✅ Confirmed: ${totalConfirmed}/${totalSplits} members`,
      env,
    );
  }
}

async function handleSettleAccept(
  ctx: CallbackCtx,
  userId: string,
  groupId: string,
  expenseId: string,
  chatId: string,
  messageId: number | undefined,
  env: Env,
): Promise<void> {
  const group = await getGroupRecord(env as unknown as AuthEnv, groupId);
  if (!group) { await ctx.answerCallbackQuery({ text: 'Group not found.' }); return; }

  const memberId = await resolveCallerMemberId(env, userId, groupId);
  if (!memberId) { await ctx.answerCallbackQuery({ text: 'You are not a member of this group.' }); return; }

  const expenses = (await getGroupExpenses(env as unknown as AuthEnv, groupId)) as Expense[];
  const expense = expenses.find((e) => e.id === expenseId);
  if (!expense) { await ctx.answerCallbackQuery({ text: 'Settlement not found.' }); return; }

  const split = expense.splits.find((s) => s.memberId === memberId);
  if (!split) {
    await ctx.answerCallbackQuery({ text: 'You are not part of this settlement.' });
    return;
  }

  split.signedOff = true;
  split.signedAt = new Date().toISOString();
  await saveGroupExpenses(env as unknown as AuthEnv, groupId, expenses);

  const currency = group.currency;
  const payerName = findMember(group, expense.paidBy)?.name ?? expense.paidBy;
  const receiverName = findMember(group, memberId)?.name ?? memberId;

  await ctx.answerCallbackQuery({ text: '✅ Receipt confirmed!' });
  if (messageId) await editTelegramMessage(
    chatId, messageId,
    `✅ <b>You confirmed receiving this payment</b>\n\n💰 Amount: <b>${formatAmount(expense.amount, currency)}</b>\n👤 From: <b>${payerName}</b>\n📝 Note: ${expense.description}`,
    env,
  );

  const payerUserId = await userIdForMember(env, groupId, expense.paidBy);
  if (payerUserId) {
    await sendTelegramNotification(
      payerUserId,
      'settlementAccepted',
      `✅ <b>${receiverName}</b> confirmed receiving your payment\n\n💰 Amount: <b>${formatAmount(expense.amount, currency)}</b>\n📝 Note: ${expense.description}`,
      env,
    );
  }
}

async function processRejection(
  userId: string,
  groupId: string,
  expenseId: string,
  chatId: string,
  messageId: number | undefined,
  ctx: CallbackCtx | null,
  env: Env,
): Promise<void> {
  const group = await getGroupRecord(env as unknown as AuthEnv, groupId);
  if (!group) return;

  const memberId = await resolveCallerMemberId(env, userId, groupId);
  if (!memberId) return;

  const expenses = (await getGroupExpenses(env as unknown as AuthEnv, groupId)) as Expense[];
  const expense = expenses.find((e) => e.id === expenseId);

  const currency = group.currency;
  const rejecterName = findMember(group, memberId)?.name ?? memberId;

  if (ctx && messageId && expense) {
    const payerName = findMember(group, expense.paidBy)?.name ?? expense.paidBy;
    await editTelegramMessage(
      chatId, messageId,
      `❌ <b>You rejected this payment</b>\n\n💰 Amount: <b>${formatAmount(expense.amount, currency)}</b>\n👤 From: <b>${payerName}</b>\n📝 Note: ${expense.description}`,
      env,
    );
  }

  if (expense) {
    const payerUserId = await userIdForMember(env, groupId, expense.paidBy);
    if (payerUserId) {
      await sendTelegramNotification(
        payerUserId,
        'settlementRejected',
        `❌ <b>${rejecterName}</b> rejected your payment\n\n💰 Amount: <b>${formatAmount(expense.amount, currency)}</b>\n📝 Note: ${expense.description}`,
        env,
      );
    }
  }
}

// ── Main router ────────────────────────────────────────────────────────────

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request } = context;
  const route = getRoutePath(request);

  if (route === 'connect' && request.method === 'POST') return handleConnect(request, context.env);
  if (route === 'disconnect' && request.method === 'DELETE') return handleDisconnect(request, context.env);
  if (route === 'status' && request.method === 'GET') return handleStatus(request, context.env);
  if (route === 'preferences' && request.method === 'PATCH') return handlePreferences(request, context.env);
  if (route === 'webhook' && request.method === 'POST') return handleWebhook(request, context.env);

  return Response.json({ success: false, error: 'Not found' }, { status: 404 });
};
