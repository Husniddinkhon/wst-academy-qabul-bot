# Wave 2 Telegram replay and idempotency controls

This wave is a local repair only. It does not authorize deployment, service
restart, production data changes, channel publication, or applicant contact.

## Durable update lifecycle

`TELEGRAM_UPDATES_FILE` stores a bounded journal keyed by Telegram `update_id`,
the raw update needed for crash recovery, and Telegraf session state.
Each record also stores a SHA-256 fingerprint of the complete update, preventing
an update ID from being reused with different content. A token-owned lease
admits one handler for a given update. Concurrent deliveries are rejected while
that owner is live. Completed records reject replays after a process restart.
Terminal records are retained by exact ID for seven days and by the configured
count bound. The implementation deliberately does not use a monotonic replay
floor because Telegram may choose a new random `update_id` after at least a week
without updates.

If a handler fails before completion, it enters persisted `retryable` state
with bounded exponential backoff. A recovery worker re-enters Telegraf with the
stored raw update, including after process restart. Completed side effects are
returned from the journal and are not run again. A claim owned by a live process
is never stolen merely because its lease timestamp elapsed; a new process can
recover it only after the recorded owner is dead. Ten unsuccessful handler
attempts fail closed as terminal `uncertain`. `TELEGRAM_UPDATE_RETENTION` bounds
terminal replay records; processing and retryable records are retained.

The update fingerprint and effect keys contain no message text, applicant name,
phone number, applicant/admin ID, bot token, or webhook secret. The stored raw
Telegram update and session state can contain applicant identifiers, messages,
contacts, and registration drafts, so the single journal file is PII-bearing
sensitive runtime data. It must remain mode `0600` inside a mode `0700` data
directory under the existing JSON controls. Telegram API results are reduced to
a Boolean, number, or `message_id`; returned message and chat objects are not
persisted. A completed AI answer may be cached so retry is deterministic.

## Side-effect rules

- Telegram API calls receive a stable key derived from `update_id`, immutable
  update route, method, hashed target identifiers, and same-target occurrence.
  Explicit semantic labels distinguish control-flow-dependent calls. Keys never
  depend on source paths, line numbers, function names, message bodies, or
  generated files, so a refactor or regenerated content cannot bypass replay
  protection. A completed result is reused on retry.
- An interrupted in-flight Telegram call becomes `uncertain`. Telegram has no
  server-side idempotency key for `sendMessage` or channel publication, so the
  bot fails closed and never automatically resends that call.
- Applicant upserts and admin lead mutations persist their update key in the
  same JSON transaction as the mutation. PostgreSQL mode uses the existing
  unique `conversation_events.idempotency_key` control.
- Channel draft, schedule, cancel, publish, and retry requests persist the
  update action key with the post. Re-entering a partially completed publish
  reuses its attempt and the journaled Telegram response.
- Follow-up creation/completion writes persist stable update keys in JSON mode;
  PostgreSQL upserts remain naturally unique by `telegram_id`.
- Webhooks always send `Idempotency-Key`, including unsigned generic delivery.
  The outbound attempt is journaled when it is caused by a Telegram update.
  Timeouts and other unknown outcomes remain queued for evidence review and are
  never automatically resent; only definite HTTP failures are retryable.
  Operator retries use token-owned per-item claims and atomic completion, so a
  concurrent append cannot be erased and concurrent retry commands cannot send
  one queued item twice. An interrupted/stale retry claim becomes uncertain.
- AI provider calls caused by a Telegram update are journaled as outbound
  effects, preventing a replay from charging or invoking the provider twice.

## Durable conversation state

The update journal is also the Telegraf session store. Session mutations are
staged during handling and written in the same atomic JSON generation as the
terminal update transition. A crash before that commit leaves both the previous
session and the retryable raw update intact. A durable per-session claim queues
later same-session updates until the earlier update commits or reaches terminal
uncertainty, preserving conversational order across polling concurrency and
process recovery. Inactive sessions expire after 30 days. Telegram message
timestamps are used for lead and follow-up times so retry output does not depend
on restart time.

## Operator response to uncertain outcomes

An uncertain update is terminal for automatic handling. Preserve its journal
record and inspect external evidence before any manual action. For a channel
send, compare the stored post attempt with channel history. For a direct reply
or admin notification, verify Telegram history. A new deliberate admin command
creates a new update ID; do not delete or edit the uncertain record to force a
replay.

## Local verification

```bash
npm run build
npx tsx --test tests/telegramUpdates.test.ts
npm test
npm run content:verify
```

On Windows, set `PYTHON_EXECUTABLE` to a trusted Python executable when the
`python3` command is not installed, then run the same gate:

```powershell
$env:PYTHON_EXECUTABLE = 'C:\path\to\python.exe'
npm.cmd run content:verify
```

The focused suite covers same-update replay, concurrent ownership, live-owner
protection, process restart and raw-update recovery, partial completion,
callback replay, interrupted outbound outcome, duplicate admin commands,
channel drafts, applicant submissions, follow-up scheduling, atomic session
commit, and webhook retry classification.
