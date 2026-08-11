# D1 migration

Chia is moving from Workers KV to D1 (SQLite). KV caches every read for 60
seconds per data centre, so a write on one device stayed invisible to another
for up to a minute; D1 reads hit the primary and are strongly consistent.
D1 transactions also replace the advisory lock that only narrowed the
read-modify-write race on a group's expense array.

We are starting with an empty database: groups and members are recreated by
hand in the app, historical transactions are imported from CSV. Everyone
registers a passkey again — the keyring lives in the old KV namespace and is
not migrated.

## Creating the database

One database holds everything — all groups, members, expenses, users and
passkeys. Creating a group later is an ordinary `INSERT` the app makes; none
of this is repeated per group.

```sh
npx wrangler d1 create chia                     # once; note the database_id
npx wrangler d1 execute chia --remote --file=d1/schema.sql
```

Current database: **`chia`** — `e721391e-d0ca-4ad3-8208-245c18083e0d`.

Then bind it in the Cloudflare dashboard (Pages project → Settings →
Bindings → D1) as variable name `DB`, for **both** Production and Preview.
The dashboard is the source of truth for bindings because `wrangler.toml` is
untracked. Keep `SPLITTER_KV` bound as well until Telegram storage moves too.

Without an API token, both steps can also be done from the dashboard's D1
console by pasting `d1/schema.sql`.

## Importing a group's history

1. Create the group and all its members in the app first — the importer
   resolves member names to ids, it does not create members.
2. Note the group id (visible in the URL, or `SELECT id, name FROM groups`).
3. Write the CSV (see format below).
4. Generate and review the SQL, then run it:

```sh
node scripts/csv-to-sql.mjs --group <groupId> dad.csv > dad.sql
less dad.sql                                     # sanity-check a few rows
npx wrangler d1 execute chia --remote --file=dad.sql
```

Everything is wrapped in one transaction: if any name fails to resolve or an
`exact` split does not sum to the total, nothing is inserted.

## CSV format

Header row required; column order does not matter; unknown columns are ignored.

| column | required | meaning |
| --- | --- | --- |
| `date` | yes | `YYYY-MM-DD` or a full datetime. Date-only is treated as local noon so timezones cannot shift the day. |
| `description` | yes | free text |
| `amount` | yes | total paid, `250` or `250.5` (comma decimals accepted) |
| `paid_by` | yes | member name, matched case-insensitively |
| `split` | yes | see below |
| `type` | no | `expense` (default) or `settlement` |
| `tags` | no | comma-separated, lowercased |
| `accepted` | no | `yes` (default) marks splits as already signed off; `no` leaves them pending |

`split` accepts four shapes:

| value | meaning |
| --- | --- |
| `all` | every active member, equal shares |
| `Minh,Dad` | those members, equal shares |
| `Minh:2,Dad:1` | weighted shares |
| `Minh=150,Dad=100` | exact amounts; must sum to `amount` |

For `type=settlement`, `split` names the single recipient.

Rounding remainders go to the payer, so splits always sum exactly to the
total.

### Example

```csv
date,description,amount,paid_by,split,tags,type
2026-08-01,Lunch,250,Minh,all,food,
2026-08-02,Taxi,120,Dad,"Minh:2,Dad:1",travel,
2026-08-03,Groceries,301,Minh,"Minh=200.5,Dad=100.5",,
2026-08-04,Payback,100,Dad,Minh,,settlement
```

## Exporting later

D1 is plain SQLite, so leaving Cloudflare is a single command:

```sh
npx wrangler d1 export chia --remote --output=chia.sql
```

The dump loads into local `sqlite3`, Turso/libSQL, or converts to Postgres
with minor edits.
