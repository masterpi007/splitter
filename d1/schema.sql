-- Chia — D1 (SQLite) schema.
--
-- Replaces the KV store. KV's 60-second per-PoP read cache made writes
-- invisible to other devices for up to a minute; D1 reads hit the primary and
-- are strongly consistent. Transactions also remove the need for the advisory
-- locks that only narrowed the read-modify-write race on the expense array.
--
-- Conventions:
--   * ids are application-generated UUID strings (crypto.randomUUID())
--   * timestamps are ISO-8601 UTC strings, so they sort lexicographically
--   * money is REAL in the group's currency unit (same as the KV model)
--   * ephemeral records carry expires_at and are swept lazily on read plus by
--     a scheduled sweep; SQLite has no TTL of its own

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity --

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar_seed TEXT,
  created_at  TEXT NOT NULL
);

-- WebAuthn keyring. One row per registered passkey; a user may have several.
CREATE TABLE credentials (
  id           TEXT PRIMARY KEY,           -- base64url credential id
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key   TEXT NOT NULL,              -- base64url
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,                       -- JSON array
  device_type  TEXT,
  backed_up    INTEGER NOT NULL DEFAULT 0,
  name         TEXT,                       -- user-facing device label
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX credentials_user_idx ON credentials(user_id);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

-- WebAuthn challenges, passkey-device invites, Telegram connect tokens and
-- callbacks all share this shape: short-lived opaque token -> JSON payload.
CREATE TABLE ephemeral (
  key        TEXT PRIMARY KEY,   -- e.g. 'challenge:<userId>', 'tg-cb:<token>'
  kind       TEXT NOT NULL,      -- challenge | passkey_invite | tg_connect | ...
  payload    TEXT NOT NULL,      -- JSON
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX ephemeral_expiry_idx ON ephemeral(expires_at);
CREATE INDEX ephemeral_kind_idx ON ephemeral(kind);

-- ------------------------------------------------------------------ groups --

CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- A member row is both the group roster entry and the membership link: a row
-- with user_id set means that user belongs to this group. Placeholder members
-- (admin typed a name before the person joined) have user_id NULL.
-- removed_at set = soft-removed; kept so old expenses still resolve names.
CREATE TABLE members (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  avatar_seed     TEXT,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  share           REAL,                    -- NULL/<=0 treated as 1
  bank_id         TEXT,
  bank_name       TEXT,
  bank_short_name TEXT,
  account_name    TEXT,
  account_no      TEXT,
  joined_at       TEXT,
  removed_at      TEXT
);
CREATE INDEX members_group_idx ON members(group_id);
CREATE INDEX members_user_idx ON members(user_id);
CREATE UNIQUE INDEX members_group_name_idx
  ON members(group_id, lower(name)) WHERE removed_at IS NULL;

CREATE TABLE group_invites (
  code       TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX group_invites_group_idx ON group_invites(group_id);

-- ---------------------------------------------------------------- expenses --

-- split_type: 'exact' (per-item/per-member amounts) | 'shares' | 'group'
--             (breakdown computed from live member weights) | 'settlement'
CREATE TABLE expenses (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  amount        REAL NOT NULL,
  paid_by       TEXT NOT NULL REFERENCES members(id),
  created_by    TEXT REFERENCES members(id),
  split_type    TEXT NOT NULL,
  discount      REAL,
  discount_type TEXT,                      -- 'percentage' | 'flat'
  receipt_url   TEXT,
  receipt_date  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX expenses_group_idx ON expenses(group_id);
-- Lists and the chart both order by payment date, falling back to entry time.
CREATE INDEX expenses_group_date_idx
  ON expenses(group_id, coalesce(receipt_date, created_at));

-- Persisted per-member breakdown. Absent for 'group' expenses, whose split is
-- derived from current member weights on every read.
CREATE TABLE expense_splits (
  expense_id      TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id       TEXT NOT NULL REFERENCES members(id),
  value           REAL NOT NULL,           -- meaning depends on split_type
  amount          REAL NOT NULL,
  signed_off      INTEGER NOT NULL DEFAULT 0,
  signed_at       TEXT,
  previous_amount REAL,                    -- set when an edit changed the share
  PRIMARY KEY (expense_id, member_id)
);
CREATE INDEX expense_splits_member_idx ON expense_splits(member_id);

-- Acceptance ledger for 'group' expenses (their splits are ephemeral).
CREATE TABLE expense_signoffs (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id),
  signed_at  TEXT NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);

CREATE TABLE expense_items (
  id          TEXT PRIMARY KEY,
  expense_id  TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  amount      REAL NOT NULL,
  member_id   TEXT REFERENCES members(id),  -- NULL = unassigned
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX expense_items_expense_idx ON expense_items(expense_id);

CREATE TABLE expense_tags (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (expense_id, tag)
);
CREATE INDEX expense_tags_tag_idx ON expense_tags(tag);

-- Server-recorded edit log shown as the Activity timeline.
CREATE TABLE expense_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  by_member  TEXT REFERENCES members(id),
  changes    TEXT NOT NULL                 -- JSON array of {field,from,to}
);
CREATE INDEX expense_history_expense_idx ON expense_history(expense_id, at);

-- ----------------------------------------------------------- notifications --

CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id   TEXT REFERENCES groups(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX push_subs_endpoint_idx ON push_subscriptions(user_id, endpoint);
CREATE INDEX push_subs_user_group_idx ON push_subscriptions(user_id, group_id);

CREATE TABLE push_prefs (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  prefs    TEXT NOT NULL,                  -- JSON NotifyPrefs
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id   TEXT REFERENCES groups(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  url        TEXT,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_user_idx ON notifications(user_id, group_id, created_at);

CREATE TABLE telegram_links (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id       TEXT NOT NULL,
  telegram_name TEXT,
  linked_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX telegram_chat_idx ON telegram_links(chat_id);
