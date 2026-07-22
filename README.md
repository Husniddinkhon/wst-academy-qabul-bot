# WST Academy Qabul Bot

Production-ready Telegram lead capture bot for WST Academy “0 dan ustagacha” videokuzatuv kursi.

## Features

- `/start` course introduction and main menu
- `/start ads_<campaign>` keeps campaign attribution only in the private in-memory session; opening an ad never creates a lead, notification, webhook, or follow-up
- Public `/help`, `/lesson`, `/quiz`, `/calculator`, and `/cancel` commands work without registration or phone sharing
- Three-module CCTV mini-lesson, five-question session-only quiz, and bounded camera-storage calculator
- Step-by-step Uzbek-first registration with separate application, outbound-message, and follow-up consent
- Durable internal applicant identity, verified self-shared Telegram contacts, conflict review, withdrawal, and `/withdraw_consent`
- Role- and scope-authorized masked notifications for every new lead
- `/id` command to discover Telegram user ID
- Durable role- and scope-authorized commands:
  - `/admin_help` — admin command reference
  - `/leads_today` — today's leads
  - `/last_leads` — latest 10 leads
  - `/hot_leads` — hot AI-scored leads
  - `/call_requests` — users who requested an operator call
  - `/export_csv [approval_id]` — maker-checker protected all-lead CSV export
  - `/stats` — total, today, and last 7 days statistics
  - `/lead <applicant_ref>` — inspect a masked lead
  - `/lead_sensitive <applicant_ref> <purpose>` — purpose-bound sensitive view
  - `/set_status <applicant_ref> <status>` — update CRM status
  - `/operator_note <applicant_ref> <note>` — save operator notes
  - `/approvals`, `/approve`, `/reject` — maker-checker workflow
  - `/retry_webhooks` — retry failed webhook deliveries
- Daily admin report automation
- Follow-up automation for leads who have not completed registration
- Local JSON storage with atomic writes
- Durable Telegram `update_id` replay protection and persistent wizard sessions
- Stable per-update keys for applicant, admin, publication, follow-up, webhook, AI, and Telegram API side effects
- Optional n8n-compatible lead webhook delivery
- Environment-based configuration; no bot token in code
- Campaign attribution is attached only after explicit registration or an operator call request with a submitted phone number
- Typed, forwarded, or third-party phone contacts never establish ownership; duplicate identities and phones fail closed without an automatic merge
- Bot destination long and short descriptions synchronized automatically on every startup
- Persistent channel draft and audited publish workflow for `@wstacademy_uz`

## Course details used by the bot

- Duration: 1 month
- Lessons: 12 lessons
- Format: offline practical course
- Venue: Toshkent shahri, Arnasoy ko‘chasi, 33-uy
- Next group planned start: 2026-08-04; it may shift by 1–2 days depending on enrollment
- Lesson weekdays are selected based on group demand
- Lessons are scheduled within 10:00–16:00; this is not a promise of a continuous six-hour class
- Price: 2 500 000 so‘m
- Installment: 1 500 000 so‘m first, remaining by end of first week
- Certificate and job guidance are included
- The bot never promises a guaranteed job
- Channel: <https://t.me/wstacademy_uz>
- Operator: `@hr_wst`
- Phone: `+998333011511`

## Requirements

- Node.js 20+
- npm
- Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```env
BOT_TOKEN=your-real-bot-token
ADMIN_IDS=123456789,987654321
LEADS_FILE=./data/leads.json
APPLICANT_IDENTITIES_FILE=./data/applicant_identities.json
AUTHORIZATION_FILE=./data/authorization.json
WEBHOOK_FAILED_FILE=./data/webhook_failed.json
FOLLOWUPS_FILE=./data/followups.json
TELEGRAM_UPDATES_FILE=./data/telegram_updates.json
TELEGRAM_UPDATE_LEASE_MS=300000
TELEGRAM_UPDATE_RETENTION=100000
LEAD_WEBHOOK_URL=
LEAD_WEBHOOK_SERVICE_ID=
LEAD_WEBHOOK_SECRET=
DAILY_REPORT_ENABLED=true
DAILY_REPORT_HOUR=21
NODE_ENV=production
```

Use `/id` to discover the initial owner identities. `ADMIN_IDS` is consumed only once when the durable authorization ledger is empty; it is never a continuing authorization check. Thereafter roles, scopes, expiry, revocation, and maker-checker state in `AUTHORIZATION_FILE` are authoritative. Privileged users can run `/admin_help` for command formats. Set `LEAD_WEBHOOK_URL` only if you want lead events posted to n8n, the Academy API, or another webhook receiver. `WEBHOOK_FAILED_FILE` stores failed webhook deliveries for `/retry_webhooks`, and `FOLLOWUPS_FILE` stores follow-up automation state. `DAILY_REPORT_ENABLED=false` disables the daily authorized summary; `DAILY_REPORT_HOUR` accepts an hour from 0 to 23 and defaults to 21.

### Signed Academy lead delivery

To send leads to `POST /api/v1/admissions/bot-leads`, configure all three values:

```env
LEAD_WEBHOOK_URL=https://academy.montag.uz/api/v1/admissions/bot-leads
LEAD_WEBHOOK_SERVICE_ID=wst-academy-telegram-bot
LEAD_WEBHOOK_SECRET=use-the-same-random-secret-as-the-academy-api
```

The secret must contain at least 32 characters and must match the Academy API configuration. The bot signs the exact JSON bytes with lowercase hexadecimal HMAC-SHA256 over `timestamp + "\\n" + nonce + "\\n" + body`. Signed requests include `X-Service-Id`, `X-Service-Timestamp`, `X-Service-Nonce`, `X-Service-Signature`, and a body-stable `Idempotency-Key`. Each retry gets a fresh timestamp and nonce while retaining the same idempotency key for the same lead body.

When the signing variables are absent, the webhook keeps its existing generic payload and sends no Academy authentication headers. `LEAD_WEBHOOK_SERVICE_ID` and `LEAD_WEBHOOK_SECRET` must always be set together. Never commit the real secret or print it in logs.

## Scripts

```bash
npm run dev
npm run build
npm start
```

- `npm run dev` starts the TypeScript bot in watch mode.
- `npm run build` compiles TypeScript to `dist/`.
- `npm start` runs the compiled production build.

## Data storage

Leads are stored locally in `data/leads.json` by default. The separate applicant identity and consent ledger defaults to `data/applicant_identities.json`; the durable authorization ledger defaults to `data/authorization.json`. Override them only with `APPLICANT_IDENTITIES_FILE` and `AUTHORIZATION_FILE`. Failed webhook deliveries and follow-up state default to `data/webhook_failed.json` and `data/followups.json`, configurable with `WEBHOOK_FAILED_FILE` and `FOLLOWUPS_FILE`. Telegram update claims, recoverable raw updates, and durable session state share `data/telegram_updates.json`, allowing one atomic commit per handled update. Keep every state file private; inactive sessions expire after 30 days.

The `data/*.json` files are ignored by Git to avoid committing personal lead data.

JSON lock ownership, backup generations, recovery order, and operational guidance are documented in
[`docs/wave-1-storage-reliability.md`](docs/wave-1-storage-reliability.md). The current security,
durability, and workflow backlog is maintained in [`docs/defect-register.md`](docs/defect-register.md).
Wave 2 replay, crash, and uncertain-outcome behavior is documented in
[`docs/wave-2-telegram-idempotency.md`](docs/wave-2-telegram-idempotency.md).
Wave 3 publication reconciliation, shutdown, follow-up claims, and webhook
dead-letter controls are documented in
[`docs/wave-3-publication-reconciliation.md`](docs/wave-3-publication-reconciliation.md),
[`docs/wave-3-worker-shutdown-followups.md`](docs/wave-3-worker-shutdown-followups.md), and
[`docs/wave-3-webhook-retry-policy.md`](docs/wave-3-webhook-retry-policy.md).
The secret-safe Wave 3.1B staging identity and channel-permission check is documented in
[`docs/wave-3.1b-staging-precheck.md`](docs/wave-3.1b-staging-precheck.md). Its
`npm run staging:precheck` command never polls or sends, edits, deletes, or publishes a Telegram message.
Wave 4 applicant identity, purpose-specific consent, contact ownership, validation, minimization, migration, and withdrawal controls are documented in
[`docs/wave-4-applicant-identity-consent.md`](docs/wave-4-applicant-identity-consent.md).
Wave 5 roles, scopes, masked defaults, maker-checker, signed privileged callbacks, revocation, migration, and authorization audit controls are documented in
[`docs/wave-5-admin-rbac-maker-checker.md`](docs/wave-5-admin-rbac-maker-checker.md).

## Deployment notes

1. Install dependencies with `npm ci`.
2. Create a production `.env` file with `BOT_TOKEN`, `ADMIN_IDS`, and optional `LEADS_FILE`.
3. Optionally set `LEAD_WEBHOOK_URL` for generic forwarding, or configure both signing variables for Academy delivery.
4. Run `npm run build`.
5. Start or reload only through the tracked PM2 ecosystem file below.

### Production PM2 runbook

The bot deliberately loads its own `/opt/wst-academy-qabul-bot/.env` through
`dotenv`. PM2 must not copy the deployment shell, Academy Portal, database,
JWT, trusted-host, or other service secrets into the bot process. The tracked
ecosystem uses `filter_env: true` and injects only `NODE_ENV=production`.

Keep `.env` readable only by the service owner and never source another
application's environment before deployment:

```bash
cd /opt/wst-academy-qabul-bot
chmod 600 .env
npm ci
npm run build
npm test
npm run content:verify

# One-time migration when the existing process was created without this file:
/usr/bin/pm2 delete wst-academy-qabul-bot
env -i HOME=/root PATH=/usr/bin:/bin PM2_HOME=/root/.pm2 \
  /usr/bin/pm2 start ecosystem.config.cjs \
  --only wst-academy-qabul-bot --env production

# Routine release after the one-time migration:
env -i HOME=/root PATH=/usr/bin:/bin PM2_HOME=/root/.pm2 \
  /usr/bin/pm2 startOrReload ecosystem.config.cjs \
  --only wst-academy-qabul-bot --env production --update-env
/usr/bin/pm2 save
npm run pm2:audit-env
```

Before and after a reload, record the channel post status counts and next
scheduled timestamp with the admin-only `/ops_report`. The counts and next
timestamp must remain unchanged; a reload never uses Telegram's
`dropPendingUpdates` option. If the env audit reports a forbidden key name,
do not print its value: stop the release, correct the PM2 declaration, and
reload once from the clean command above.

### Durable operational failure alerts

Channel posts that enter `Failed` or `Uncertain` are reconciled by the qabul scheduler. Only
failures from the last 24 hours are actionable. Each admin recipient is tracked
independently by a SHA-256 fingerprint: Telegram success is persisted before a
recipient is considered delivered, failed delivery uses bounded exponential
backoff, and the same post failure attempt is never sent twice.

Academy health, Academy backup, and WST Sales campaign systemd services use the
tracked `wst-academy-ops-alert@.service` through `OnFailure` drop-ins. The state
file defaults to `./data/ops_alerts.json`, is mode `0600`, and applies a
persisted one-hour cooldown per failed unit. The notifier itself has no
`OnFailure`, preventing recursive alert loops. Install or refresh the units:

```bash
install -m 0644 deploy/systemd/wst-academy-ops-alert@.service /etc/systemd/system/
for unit in wst-academy-health wst-academy-backup wst-sales-campaign; do
  install -d -m 0755 "/etc/systemd/system/${unit}.service.d"
  install -m 0644 deploy/systemd/ops-alert.conf \
    "/etc/systemd/system/${unit}.service.d/ops-alert.conf"
done
systemd-analyze verify /etc/systemd/system/wst-academy-ops-alert@.service
systemctl daemon-reload
npm run ops:alert-dry-run
```

The dry-run validates unit-name and invocation discovery only. It never sends a
Telegram message, changes a campaign, publishes a post, or mutates alert state.
