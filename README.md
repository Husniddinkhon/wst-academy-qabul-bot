# WST Academy Qabul Bot

Production-ready Telegram lead capture bot for WST Academy “0 dan ustagacha” videokuzatuv kursi.

## Features

- `/start` course introduction and main menu
- `/start ads` automatically creates or updates a Telegram Ads lead, notifies admins for new ad leads, starts follow-up tracking, and sends the lead webhook
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

## Course details used by the bot

- Duration: 1 month
- Lessons: 12 lessons
- Format: offline practical course
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
DAILY_REPORT_ENABLED=true
DAILY_REPORT_HOUR=21
NODE_ENV=production
```

Use `/id` in the bot to find admin Telegram IDs, then add them to `ADMIN_IDS`. Admins can run `/admin_help` in Telegram to see command formats. Set `LEAD_WEBHOOK_URL` only if you want lead events posted to n8n or another webhook receiver. `WEBHOOK_FAILED_FILE` stores failed webhook deliveries for `/retry_webhooks`, and `FOLLOWUPS_FILE` stores follow-up automation state. `DAILY_REPORT_ENABLED=false` disables the daily admin summary; `DAILY_REPORT_HOUR` accepts an hour from 0 to 23 and defaults to 21.

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
3. Optionally set `LEAD_WEBHOOK_URL` for n8n lead forwarding.
4. Run `npm run build`.
5. Start with `npm start` under a process manager such as PM2 or systemd.

Example PM2 command:

```bash
pm2 start dist/index.js --name wst-academy-qabul-bot
```
