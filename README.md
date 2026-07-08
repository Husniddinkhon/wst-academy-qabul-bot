# WST Academy Qabul Bot

Production-ready Telegram lead capture bot for WST Academy “0 dan ustagacha” videokuzatuv kursi.

## Features

- `/start` course introduction and main menu
- Step-by-step registration flow
- Admin notifications for every new lead
- `/id` command to discover Telegram user ID
- Admin commands:
  - `/leads_today` — today's leads
  - `/last_leads` — latest 10 leads
  - `/export_csv` — export all leads as CSV
  - `/stats` — total, today, and last 7 days statistics
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
- Phone: `+998 33 301 15 11`

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
LEAD_WEBHOOK_URL=
NODE_ENV=production
```

Use `/id` in the bot to find admin Telegram IDs, then add them to `ADMIN_IDS`. Set `LEAD_WEBHOOK_URL` only if you want completed leads posted to n8n or another webhook receiver.

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

Leads are stored locally in `data/leads.json` by default. You can change this path with `LEADS_FILE`.

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
