# Chia

A shared expense-splitting app: passkey sign-in, per-group balances, receipt
scanning, web push and Telegram notifications. Runs on Cloudflare Pages with
D1 (SQLite) as the datastore.

Live at [split.masterpi.me](https://split.masterpi.me).

## How it fits together

| Piece | What it does |
| --- | --- |
| `src/` | React + Vite front end |
| `functions/api/` | Cloudflare Pages Functions — the whole API |
| `functions/api/utils/db.ts` | the only module that knows about tables; everything above it works with nested objects |
| `d1/schema.sql` | database schema (see [`d1/README.md`](d1/README.md)) |
| `scripts/csv-to-sql.mjs` | one-off CSV → SQL importer for historical data |

Authentication is WebAuthn only — there are no passwords. A **user** owns
passkeys and belongs to groups; a **member** row is that user's identity
inside one group. A member row with no user attached is a *placeholder*: an
admin can add someone by name and split expenses with them straight away, and
the row is claimed automatically when that person signs up through an invite
link using the same name.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- A [Cloudflare](https://cloudflare.com) account

```bash
pnpm install
```

## Configuration

Bindings, variables and secrets are configured in the **Cloudflare dashboard**
(Pages project → Settings), not in `wrangler.toml` — the file is untracked so
the dashboard stays the single source of truth. Apply every binding to both
the Production and Preview environments.

### 1. Create the Pages project

```bash
pnpm wrangler pages project create chia
```

Connect it to the GitHub repository so pushes to `main` deploy automatically.

### 2. Create the database

```bash
pnpm wrangler d1 create chia
pnpm wrangler d1 execute chia --remote --file=d1/schema.sql
```

Bind it as variable name **`DB`**. One database holds every group; creating a
group later is an ordinary insert the app makes. Details, including importing
historical data from CSV, are in [`d1/README.md`](d1/README.md).

### 3. Generate VAPID keys (one-time)

Required for web push. Generate once and keep them — regenerating breaks every
existing subscription.

```bash
npx tsx scripts/generate-vapid-keys.ts
```

The **public** key and a contact address go in as plaintext variables; the
**private** key is a secret.

### 4. Set up a Telegram bot (optional)

1. Create a bot with [@BotFather](https://t.me/BotFather) to get a
   `TELEGRAM_BOT_TOKEN`.
2. Invent a webhook secret (`openssl rand -hex 32`).
3. Once deployed, register the webhook:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://split.masterpi.me/api/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 5. Variables and secrets

| Name | Type | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | secret | signs session cookies; ≥32 random characters |
| `VAPID_PRIVATE_KEY` | secret | web push |
| `TELEGRAM_BOT_TOKEN` | secret | Telegram bot (optional) |
| `TELEGRAM_WEBHOOK_SECRET` | secret | proves webhook calls come from Telegram |
| `VAPID_PUBLIC_KEY` | plaintext | pairs with the private key |
| `VAPID_SUBJECT` | plaintext | contact address, e.g. `mailto:admin@example.com` |
| `APP_ADMIN_USER_IDS` | plaintext | comma-separated user ids with cross-group admin rights (passkey recovery for any member) |

There is deliberately **no domain configuration**. The WebAuthn relying-party
id, origin and name are derived from the request URL
(`functions/api/utils/rp.ts`), so moving the app to another domain needs no
config change. `RP_ID`, `RP_ORIGIN` and `RP_NAME` still exist as optional
overrides for the rare case of pinning one id across several hostnames.

Note that passkeys are cryptographically bound to the domain they were created
on: after a domain move every member registers a new passkey, which an admin
enables with the *Reset passkey* link on their member row.

## Local development

Copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill it in, then:

```bash
pnpm dev
```

`wrangler pages dev` needs a local D1 binding; the first run creates an empty
local database, which you can populate with:

```bash
pnpm wrangler d1 execute chia --local --file=d1/schema.sql
```

## Deployment

Pushing to `main` builds and deploys through the GitHub integration. To deploy
by hand:

```bash
pnpm build
pnpm wrangler pages deploy dist --project-name chia
```

## Backups

D1 is plain SQLite, so a backup — and any future migration off Cloudflare — is
one command:

```bash
pnpm wrangler d1 export chia --remote --output=chia-backup.sql
```

The dump restores into local `sqlite3`, Turso/libSQL, or converts to Postgres
with minor edits.
