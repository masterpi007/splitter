// Row <-> object mapping for D1.
//
// The rest of the codebase keeps working with the nested shapes it always
// used (a GroupRecord carrying its members, an Expense carrying its splits,
// items, tags and history), so this module owns the flattening in both
// directions and nothing above it needs to know about tables.

import type { AuthEnv } from '../types/auth';
import type {
  Expense,
  ExpenseSplit,
  GroupMember,
  GroupRecord,
  GroupSignOff,
  ExpenseHistoryEntry,
  SplitType,
} from './groups';

// SQLite has no booleans; 0/1 round-trips through INTEGER columns.
const bit = (v: unknown): number => (v ? 1 : 0);
const unbit = (v: unknown): boolean => v === 1 || v === true;
// Optional TEXT columns come back as null; the object shapes use undefined.
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export interface MemberRow {
  id: string;
  group_id: string;
  user_id: string | null;
  name: string;
  avatar_seed: string | null;
  is_admin: number;
  share: number | null;
  bank_id: string | null;
  bank_name: string | null;
  bank_short_name: string | null;
  account_name: string | null;
  account_no: string | null;
  joined_at: string | null;
  removed_at: string | null;
}

export function rowToMember(r: MemberRow): GroupMember {
  return {
    id: r.id,
    userId: opt(r.user_id),
    name: r.name,
    avatarSeed: opt(r.avatar_seed),
    bankId: opt(r.bank_id),
    bankName: opt(r.bank_name),
    bankShortName: opt(r.bank_short_name),
    accountName: opt(r.account_name),
    accountNo: opt(r.account_no),
    joinedAt: opt(r.joined_at),
    removedAt: opt(r.removed_at),
    share: opt(r.share),
  };
}

export function memberBindings(groupId: string, m: GroupMember, isAdmin: boolean) {
  return [
    m.id,
    groupId,
    m.userId ?? null,
    m.name,
    m.avatarSeed ?? null,
    bit(isAdmin),
    m.share ?? null,
    m.bankId ?? null,
    m.bankName ?? null,
    m.bankShortName ?? null,
    m.accountName ?? null,
    m.accountNo ?? null,
    m.joinedAt ?? null,
    m.removedAt ?? null,
  ];
}

export const MEMBER_UPSERT_SQL = `
INSERT INTO members (id, group_id, user_id, name, avatar_seed, is_admin, share,
                     bank_id, bank_name, bank_short_name, account_name, account_no,
                     joined_at, removed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  name = excluded.name,
  avatar_seed = excluded.avatar_seed,
  is_admin = excluded.is_admin,
  share = excluded.share,
  bank_id = excluded.bank_id,
  bank_name = excluded.bank_name,
  bank_short_name = excluded.bank_short_name,
  account_name = excluded.account_name,
  account_no = excluded.account_no,
  joined_at = excluded.joined_at,
  removed_at = excluded.removed_at`;

// ------------------------------------------------------------- expenses --

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  paid_by: string;
  created_by: string | null;
  split_type: string;
  discount: number | null;
  discount_type: string | null;
  receipt_url: string | null;
  receipt_date: string | null;
  created_at: string;
}

// Load a group's expenses with their children. Six flat queries assembled in
// memory beats N+1 round-trips per expense; D1 batches them in one request.
export async function loadExpenses(env: AuthEnv, groupId: string): Promise<Expense[]> {
  const [expenses, splits, signoffs, items, tags, history] = await env.DB.batch([
    env.DB.prepare(
      `SELECT * FROM expenses WHERE group_id = ? ORDER BY coalesce(receipt_date, created_at)`,
    ).bind(groupId),
    env.DB.prepare(
      `SELECT s.* FROM expense_splits s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?`,
    ).bind(groupId),
    env.DB.prepare(
      `SELECT o.* FROM expense_signoffs o JOIN expenses e ON e.id = o.expense_id WHERE e.group_id = ?`,
    ).bind(groupId),
    env.DB.prepare(
      `SELECT i.* FROM expense_items i JOIN expenses e ON e.id = i.expense_id WHERE e.group_id = ? ORDER BY i.position`,
    ).bind(groupId),
    env.DB.prepare(
      `SELECT t.* FROM expense_tags t JOIN expenses e ON e.id = t.expense_id WHERE e.group_id = ?`,
    ).bind(groupId),
    env.DB.prepare(
      `SELECT h.* FROM expense_history h JOIN expenses e ON e.id = h.expense_id WHERE e.group_id = ? ORDER BY h.at`,
    ).bind(groupId),
  ]);

  const byId = new Map<string, Expense>();
  const out: Expense[] = [];
  for (const r of expenses.results as unknown as ExpenseRow[]) {
    const e: Expense = {
      id: r.id,
      description: r.description,
      amount: r.amount,
      paidBy: r.paid_by,
      createdBy: opt(r.created_by),
      splitType: r.split_type as SplitType,
      splits: [],
      createdAt: r.created_at,
      receiptUrl: opt(r.receipt_url),
      receiptDate: opt(r.receipt_date),
      discount: opt(r.discount),
      discountType: opt(r.discount_type),
    };
    byId.set(e.id, e);
    out.push(e);
  }

  for (const s of splits.results as unknown as {
    expense_id: string; member_id: string; value: number; amount: number;
    signed_off: number; signed_at: string | null; previous_amount: number | null;
  }[]) {
    const e = byId.get(s.expense_id);
    if (!e) continue;
    const split: ExpenseSplit & { previousAmount?: number } = {
      memberId: s.member_id,
      value: s.value,
      amount: s.amount,
      signedOff: unbit(s.signed_off),
      signedAt: opt(s.signed_at),
    };
    if (s.previous_amount !== null) split.previousAmount = s.previous_amount;
    e.splits.push(split);
  }

  for (const o of signoffs.results as unknown as GroupSignOffRow[]) {
    const e = byId.get(o.expense_id);
    if (!e) continue;
    (e.signedOffBy ??= []).push({ memberId: o.member_id, signedAt: o.signed_at } as GroupSignOff);
  }

  for (const i of items.results as unknown as {
    id: string; expense_id: string; description: string; amount: number; member_id: string | null;
  }[]) {
    const e = byId.get(i.expense_id);
    if (!e) continue;
    ((e as any).items ??= []).push({
      id: i.id,
      description: i.description,
      amount: i.amount,
      memberId: opt(i.member_id),
    });
  }

  for (const t of tags.results as unknown as { expense_id: string; tag: string }[]) {
    const e = byId.get(t.expense_id);
    if (!e) continue;
    (e.tags ??= []).push(t.tag);
  }

  for (const h of history.results as unknown as {
    expense_id: string; at: string; by_member: string | null; changes: string;
  }[]) {
    const e = byId.get(h.expense_id);
    if (!e) continue;
    (e.history ??= []).push({
      at: h.at,
      by: h.by_member ?? '',
      changes: JSON.parse(h.changes),
    } as ExpenseHistoryEntry);
  }

  return out;
}

interface GroupSignOffRow {
  expense_id: string;
  member_id: string;
  signed_at: string;
}

// Statements that write one whole expense (parent + children). Callers run
// them inside a batch so an expense never lands half-written.
export function expenseWriteStatements(env: AuthEnv, groupId: string, e: Expense) {
  const stmts = [
    env.DB.prepare(
      `INSERT INTO expenses (id, group_id, description, amount, paid_by, created_by, split_type,
                             discount, discount_type, receipt_url, receipt_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         description = excluded.description,
         amount = excluded.amount,
         paid_by = excluded.paid_by,
         created_by = excluded.created_by,
         split_type = excluded.split_type,
         discount = excluded.discount,
         discount_type = excluded.discount_type,
         receipt_url = excluded.receipt_url,
         receipt_date = excluded.receipt_date`,
    ).bind(
      e.id, groupId, e.description, e.amount, e.paidBy, e.createdBy ?? null, e.splitType,
      e.discount ?? null, e.discountType ?? null, e.receiptUrl ?? null,
      e.receiptDate ?? null, e.createdAt,
    ),
    // Children are replaced wholesale: simpler and safe, since an expense's
    // split/item/tag sets are small and always rewritten as a unit.
    env.DB.prepare(`DELETE FROM expense_splits WHERE expense_id = ?`).bind(e.id),
    env.DB.prepare(`DELETE FROM expense_signoffs WHERE expense_id = ?`).bind(e.id),
    env.DB.prepare(`DELETE FROM expense_items WHERE expense_id = ?`).bind(e.id),
    env.DB.prepare(`DELETE FROM expense_tags WHERE expense_id = ?`).bind(e.id),
  ];

  for (const s of e.splits ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO expense_splits (expense_id, member_id, value, amount, signed_off, signed_at, previous_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        e.id, s.memberId, s.value, s.amount, bit(s.signedOff), s.signedAt ?? null,
        (s as { previousAmount?: number }).previousAmount ?? null,
      ),
    );
  }
  for (const o of e.signedOffBy ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO expense_signoffs (expense_id, member_id, signed_at) VALUES (?, ?, ?)`,
      ).bind(e.id, o.memberId, o.signedAt),
    );
  }
  const items = (e as any).items as
    | { id: string; description?: string; amount: number; memberId?: string }[]
    | undefined;
  items?.forEach((it, idx) => {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO expense_items (id, expense_id, description, amount, member_id, position)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(it.id, e.id, it.description ?? '', it.amount, it.memberId ?? null, idx),
    );
  });
  for (const tag of e.tags ?? []) {
    stmts.push(
      env.DB.prepare(`INSERT INTO expense_tags (expense_id, tag) VALUES (?, ?)`).bind(e.id, tag),
    );
  }
  // History rows are append-only; the parent's ON CONFLICT path never clears
  // them, so only genuinely new entries are inserted here.
  for (const h of e.history ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO expense_history (expense_id, at, by_member, changes)
         SELECT ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM expense_history WHERE expense_id = ? AND at = ?)`,
      ).bind(e.id, h.at, h.by || null, JSON.stringify(h.changes), e.id, h.at),
    );
  }
  return stmts;
}

// ------------------------------------------------------------ ephemeral --

// Short-lived tokens (WebAuthn challenges, passkey invites, Telegram
// handshakes) share one table; expiry is enforced on read because SQLite has
// no TTL, with a sweep to keep the table from growing.
export async function putEphemeral(
  env: AuthEnv,
  key: string,
  kind: string,
  payload: unknown,
  ttlSeconds: number,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO ephemeral (key, kind, payload, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       kind = excluded.kind,
       payload = excluded.payload,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
  )
    .bind(
      key,
      kind,
      JSON.stringify(payload),
      new Date(now).toISOString(),
      new Date(now + ttlSeconds * 1000).toISOString(),
    )
    .run();
}

export async function getEphemeral<T>(env: AuthEnv, key: string): Promise<T | null> {
  const row = await env.DB.prepare(
    `SELECT payload FROM ephemeral WHERE key = ? AND expires_at > ?`,
  )
    .bind(key, new Date().toISOString())
    .first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as T) : null;
}

export async function deleteEphemeral(env: AuthEnv, key: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM ephemeral WHERE key = ?`).bind(key).run();
}

// Read-and-delete in one step for single-use tokens.
export async function takeEphemeral<T>(env: AuthEnv, key: string): Promise<T | null> {
  const value = await getEphemeral<T>(env, key);
  if (value !== null) await deleteEphemeral(env, key);
  return value;
}

export async function sweepExpired(env: AuthEnv): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ephemeral WHERE expires_at <= ?`).bind(now),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now),
  ]);
}

// ------------------------------------------------- push and notifications --

// The push/notification handlers were written against KV blobs (an array per
// user+group). These helpers keep that array-shaped API while storing rows,
// so those handlers only swap which function they call.

import type { NotificationRecord, NotifyPrefs, PushSubscriptionRecord } from '../types/auth';
import { DEFAULT_NOTIFY_PREFS } from '../types/auth';

export async function getPushSubscriptions(
  env: AuthEnv,
  userId: string,
  groupId?: string,
): Promise<PushSubscriptionRecord[]> {
  const res = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions
      WHERE user_id = ? AND (group_id IS ? OR ? IS NULL)`,
  )
    .bind(userId, groupId ?? null, groupId ?? null)
    .all<{ endpoint: string; p256dh: string; auth: string; created_at: string }>();
  return (res.results ?? []).map((r) => ({
    endpoint: r.endpoint,
    keys: { p256dh: r.p256dh, auth: r.auth },
    createdAt: r.created_at,
  }));
}

// Replaces the whole set for this user+group, matching the blob semantics the
// callers already rely on (they filter the array then write it back).
export async function savePushSubscriptions(
  env: AuthEnv,
  userId: string,
  groupId: string | undefined,
  subs: PushSubscriptionRecord[],
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND (group_id IS ? OR ? IS NULL)`,
    ).bind(userId, groupId ?? null, groupId ?? null),
    ...subs.map((s) =>
      env.DB.prepare(
        `INSERT INTO push_subscriptions (id, user_id, group_id, endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, endpoint) DO UPDATE SET
           p256dh = excluded.p256dh, auth = excluded.auth, group_id = excluded.group_id`,
      ).bind(
        crypto.randomUUID(),
        userId,
        groupId ?? null,
        s.endpoint,
        s.keys.p256dh,
        s.keys.auth,
        s.createdAt,
      ),
    ),
  ]);
}

export async function getPushPrefs(
  env: AuthEnv,
  userId: string,
  groupId: string,
): Promise<NotifyPrefs> {
  const row = await env.DB.prepare(
    `SELECT prefs FROM push_prefs WHERE user_id = ? AND group_id = ?`,
  )
    .bind(userId, groupId)
    .first<{ prefs: string }>();
  return row ? (JSON.parse(row.prefs) as NotifyPrefs) : DEFAULT_NOTIFY_PREFS;
}

export async function savePushPrefs(
  env: AuthEnv,
  userId: string,
  groupId: string,
  prefs: NotifyPrefs,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO push_prefs (user_id, group_id, prefs) VALUES (?, ?, ?)
     ON CONFLICT(user_id, group_id) DO UPDATE SET prefs = excluded.prefs`,
  )
    .bind(userId, groupId, JSON.stringify(prefs))
    .run();
}

export async function getNotifications(
  env: AuthEnv,
  userId: string,
  groupId?: string,
): Promise<NotificationRecord[]> {
  const res = await env.DB.prepare(
    `SELECT id, title, body, url, read, created_at FROM notifications
      WHERE user_id = ? AND (group_id IS ? OR ? IS NULL)
      ORDER BY created_at DESC`,
  )
    .bind(userId, groupId ?? null, groupId ?? null)
    .all<{
      id: string; title: string; body: string; url: string | null;
      read: number; created_at: string;
    }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    url: r.url ?? undefined,
    read: r.read === 1,
    createdAt: r.created_at,
  }));
}

export async function saveNotifications(
  env: AuthEnv,
  userId: string,
  groupId: string | undefined,
  list: NotificationRecord[],
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM notifications WHERE user_id = ? AND (group_id IS ? OR ? IS NULL)`,
    ).bind(userId, groupId ?? null, groupId ?? null),
    ...list.map((n) =>
      env.DB.prepare(
        `INSERT INTO notifications (id, user_id, group_id, title, body, url, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(n.id, userId, groupId ?? null, n.title, n.body, n.url ?? null, n.read ? 1 : 0, n.createdAt),
    ),
  ]);
}

export async function deletePushSubscription(
  env: AuthEnv,
  userId: string,
  endpoint: string,
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`,
  )
    .bind(userId, endpoint)
    .run();
}

// ---------------------------------------------------------------- telegram --

import type { TelegramData } from '../types/auth';

export interface TelegramEnvDb {
  DB: D1Database;
}

export async function getTelegramLink(
  env: TelegramEnvDb,
  userId: string,
): Promise<TelegramData | null> {
  const row = await env.DB.prepare(
    `SELECT chat_id, telegram_name, notify_prefs FROM telegram_links WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ chat_id: string; telegram_name: string | null; notify_prefs: string | null }>();
  if (!row) return null;
  return {
    chatId: row.chat_id,
    telegramName: row.telegram_name ?? undefined,
    notifyPrefs: row.notify_prefs ? JSON.parse(row.notify_prefs) : undefined,
  } as TelegramData;
}

export async function saveTelegramLink(
  env: TelegramEnvDb,
  userId: string,
  data: TelegramData,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO telegram_links (user_id, chat_id, telegram_name, notify_prefs, linked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id,
                                        telegram_name = excluded.telegram_name,
                                        notify_prefs = excluded.notify_prefs`,
  )
    .bind(
      userId,
      data.chatId,
      data.telegramName ?? null,
      data.notifyPrefs ? JSON.stringify(data.notifyPrefs) : null,
      new Date().toISOString(),
    )
    .run();
}

export async function deleteTelegramLink(env: TelegramEnvDb, userId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM telegram_links WHERE user_id = ?`).bind(userId).run();
}

// A chat can only be claimed by one user; the unique index enforces it.
export async function findTelegramUserByChat(
  env: TelegramEnvDb,
  chatId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT user_id FROM telegram_links WHERE chat_id = ?`,
  )
    .bind(chatId)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export async function writeExpense(env: AuthEnv, groupId: string, e: Expense): Promise<void> {
  await env.DB.batch(expenseWriteStatements(env, groupId, e));
}

export async function deleteExpenseRow(env: AuthEnv, id: string): Promise<void> {
  // Children go with it via ON DELETE CASCADE.
  await env.DB.prepare(`DELETE FROM expenses WHERE id = ?`).bind(id).run();
}

export async function loadExpense(env: AuthEnv, groupId: string, id: string): Promise<Expense | null> {
  const all = await loadExpenses(env, groupId);
  return all.find((e) => e.id === id) ?? null;
}

// Free a chat for a new owner. Deletes any link on that chat that belongs to
// someone else, so the unique index cannot reject the incoming upsert.
export async function deleteTelegramLinkByChat(
  env: TelegramEnvDb,
  chatId: string,
  exceptUserId: string,
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM telegram_links WHERE chat_id = ? AND user_id <> ?`,
  )
    .bind(chatId, exceptUserId)
    .run();
}
