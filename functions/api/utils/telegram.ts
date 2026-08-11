import { KV_KEYS, DEFAULT_NOTIFY_PREFS, DEBOUNCE_NOTIFY_TTL_SECONDS, TELEGRAM_CALLBACK_TTL_SECONDS } from '../types/auth';
import type { NotifyPrefs, TelegramData, TelegramCallbackData } from '../types/auth';
import { getEphemeral, putEphemeral, getTelegramLink, deleteTelegramLink } from './db';

interface TelegramEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
}

export type NotifyEvent = keyof NotifyPrefs;

type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

/**
 * Create a short callback token stored in KV, returning `cb:{token}`.
 * Telegram limits callback_data to 64 bytes; full UUID-based IDs exceed that.
 */
export async function createCallbackData(
  env: { DB: D1Database },
  action: string,
  groupId: string,
  expenseId: string,
): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const data: TelegramCallbackData = { action, groupId, expenseId };
  await putEphemeral(
    env as never,
    KV_KEYS.telegramCallback(token),
    'tg_callback',
    data,
    TELEGRAM_CALLBACK_TTL_SECONDS,
  );
  return `cb:${token}`;
}

/**
 * Resolve a callback_data string: handles `cb:{token}` (KV lookup) and the
 * legacy `action:groupId:expenseId` format (for short IDs like the 1matrix group).
 */
export async function resolveCallback(
  env: { DB: D1Database },
  data: string,
  legacyGroupId: string,
): Promise<{ action: string; groupId: string; expenseId: string } | null> {
  if (data.startsWith('cb:')) {
    const token = data.slice(3);
    return getEphemeral<TelegramCallbackData>(env as never, KV_KEYS.telegramCallback(token));
  }
  const parts = data.split(':');
  if (parts.length >= 3) return { action: parts[0], groupId: parts[1], expenseId: parts[2] };
  if (parts.length === 2) return { action: parts[0], groupId: legacyGroupId, expenseId: parts[1] };
  return null;
}

/**
 * Send a Telegram notification to a member.
 * Silently skips if member has no Telegram connected or pref is disabled.
 */
export async function sendTelegramNotification(
  userId: string,
  event: NotifyEvent,
  text: string,
  env: TelegramEnv,
  inlineKeyboard?: InlineKeyboard,
): Promise<void> {
  const data = await getTelegramLink(env as never, userId);
  if (!data) return;

  // The chat_id unique index makes the old reverse-mapping cross-check
  // unnecessary: one chat cannot be linked to two users in the first place.
  const prefs = data.notifyPrefs ?? DEFAULT_NOTIFY_PREFS;
  if (!prefs[event]) return;

  const body: Record<string, unknown> = {
    chat_id: data.chatId,
    text,
    parse_mode: 'HTML',
  };
  if (inlineKeyboard) body.reply_markup = inlineKeyboard;

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 403) {
    // Bot was blocked — clean up connection
    await deleteTelegramLink(env as never, userId);
  }
}

/**
 * Notify multiple members, excluding the actor.
 */
export async function notifyMembers(
  userIds: string[],
  excludeUserId: string,
  event: NotifyEvent,
  text: string,
  env: TelegramEnv,
  inlineKeyboard?: InlineKeyboard,
): Promise<void> {
  const targets = userIds.filter((id) => id !== excludeUserId);
  await Promise.all(targets.map((id) => sendTelegramNotification(id, event, text, env, inlineKeyboard)));
}

/**
 * Debounced edit notification — skips if already sent within 30s.
 * Returns true if notification was sent.
 */
export async function sendDebouncedEditNotification(
  expenseId: string,
  userIds: string[],
  excludeUserId: string,
  text: string,
  env: TelegramEnv,
  inlineKeyboard?: InlineKeyboard,
): Promise<boolean> {
  const debounceKey = KV_KEYS.debounceNotify(expenseId);
  const existing = await getEphemeral<{ held: true }>(env as never, debounceKey);
  if (existing) return false;

  await putEphemeral(env as never, debounceKey, 'debounce', { held: true }, DEBOUNCE_NOTIFY_TTL_SECONDS);
  await notifyMembers(userIds, excludeUserId, 'expenseEdited', text, env, inlineKeyboard);
  return true;
}

/**
 * Edit an existing Telegram message (removes inline buttons after action taken).
 */
export async function editTelegramMessage(
  chatId: string,
  messageId: number,
  text: string,
  env: TelegramEnv,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }),
  });
}
