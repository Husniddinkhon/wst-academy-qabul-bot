# WST Academy Qabul Bot

Production-ready Telegram lead capture bot for WST Academy “0 dan ustagacha” videokuzatuv kursi.

## Features

- `/start` course introduction and main menu
- `/start ads_<campaign>` keeps campaign attribution only in the private in-memory session; opening an ad never creates a lead, notification, webhook, or follow-up
- Public `/help`, `/lesson`, `/quiz`, `/calculator`, and `/cancel` commands work without registration or phone sharing
- Three-module CCTV mini-lesson, five-question session-only quiz, and bounded camera-storage calculator
- Step-by-step registration flow
- Admin notifications for every new lead
- `/id` command to discover Telegram user ID
- Admin commands:
  - `/admin_help` — admin command reference
  - `/leads_today` — today's leads
  - `/last_leads` — latest 10 leads
  - `/hot_leads` — hot AI-scored leads
  - `/call_requests` — users who requested an operator call
  - `/export_csv` — export all leads as CSV
  - `/stats` — total, today, and last 7 days statistics
  - `/lead <telegram_id>` — inspect one lead
  - `/set_status <telegram_id> <status>` — update CRM status
  - `/operator_note <telegram_id> <note>` — save operator notes
  - `/retry_webhooks` — retry failed webhook deliveries
- Daily admin report automation
- Follow-up automation for leads who have not completed registration
- Local JSON storage with atomic writes
- Optional n8n-compatible lead webhook delivery
- Environment-based configuration; no bot token in code
- Campaign attribution is attached only after explicit registration or an operator call request with a submitted phone number
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
WEBHOOK_FAILED_FILE=./data/webhook_failed.json
FOLLOWUPS_FILE=./data/followups.json
LEAD_WEBHOOK_URL=
LEAD_WEBHOOK_SERVICE_ID=
LEAD_WEBHOOK_SECRET=
DAILY_REPORT_ENABLED=true
DAILY_REPORT_HOUR=21
NODE_ENV=production
```

Use `/id` in the bot to find admin Telegram IDs, then add them to `ADMIN_IDS`. Admins can run `/admin_help` in Telegram to see command formats. Set `LEAD_WEBHOOK_URL` only if you want lead events posted to n8n, the Academy API, or another webhook receiver. `WEBHOOK_FAILED_FILE` stores failed webhook deliveries for `/retry_webhooks`, and `FOLLOWUPS_FILE` stores follow-up automation state. `DAILY_REPORT_ENABLED=false` disables the daily admin summary; `DAILY_REPORT_HOUR` accepts an hour from 0 to 23 and defaults to 21.

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

Leads are stored locally in `data/leads.json` by default. You can change this path with `LEADS_FILE`. Failed webhook deliveries and follow-up state default to `data/webhook_failed.json` and `data/followups.json`, configurable with `WEBHOOK_FAILED_FILE` and `FOLLOWUPS_FILE`.

The `data/*.json` files are ignored by Git to avoid committing personal lead data.

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

env -i HOME=/root PATH=/usr/bin:/bin PM2_HOME=/root/.pm2 \
  /usr/bin/pm2 startOrReload ecosystem.config.cjs \
  --only wst-academy-qabul-bot --update-env
/usr/bin/pm2 save
npm run pm2:audit-env
```

Before and after a reload, record the channel post status counts and next
scheduled timestamp with the admin-only `/ops_report`. The counts and next
timestamp must remain unchanged; a reload never uses Telegram's
`dropPendingUpdates` option. If the env audit reports a forbidden key name,
do not print its value: stop the release, correct the PM2 declaration, and
reload once from the clean command above.
