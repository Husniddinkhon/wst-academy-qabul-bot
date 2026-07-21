# Wave 3 worker shutdown and follow-up claims

## Bounded graceful shutdown

SIGTERM and SIGINT now perform this sequence:

1. Stop Telegram polling when it has started, then stop channel scheduler claims, follow-up claims, and manual publisher claims. Launch cancellation checkpoints before and after Telegraf's pre-poll webhook cleanup prevent an early signal from falling through into polling.
2. Clear periodic timers.
3. Drain active channel and follow-up sends for at most `SHUTDOWN_DRAIN_TIMEOUT_MS`.
4. A channel claim that never started send becomes `RetryWait`; an in-send channel attempt becomes `Uncertain`.
5. A follow-up claim that never started send becomes `RetryWait`; an in-send follow-up becomes `Uncertain`.
6. Close the aggregate server and PostgreSQL pool.
7. Log aggregate drain duration/status and exit non-zero if a drain timed out.

The timeout does not abort or label a possibly accepted Telegram message as unsent. If a late send returns after its claim was made uncertain, only that exact persisted attempt may attach the returned Telegram message ID and reconcile to `Published`; unrelated or stale ownership cannot overwrite the durable state and no second Telegram request is issued.

Validated settings:

- `SHUTDOWN_DRAIN_TIMEOUT_MS`: 1–300 seconds, default 30 seconds.
- `CHANNEL_CLAIM_LEASE_MS`: 1 minute–24 hours, default 10 minutes.
- `CHANNEL_CLAIM_RENEW_MS`: 5 seconds–1 hour and strictly shorter than the lease, default 2 minutes.
- `CHANNEL_UNCERTAIN_WINDOW_MS`: 5 minutes–7 days, default 24 hours.

## Follow-up delivery state

The existing `followups` JSON/PostgreSQL payload is extended without schema redesign. Every delivery records:

- stable `followUpId` (`recipient + ordinal + task`), assigned recipient/task, due time, and `Asia/Tashkent`;
- `Claimed`/`Sending`/`RetryWait`/`Sent`/`Uncertain`/`Failed`/`Cancelled` state;
- random claim token, worker, claimed time, lease expiry, attempt count, next retry, terminal time, and bounded audit history.

JSON uses the Wave 1 token-owned file lock. PostgreSQL uses the existing per-recipient advisory transaction lock and JSONB payload; Wave 3 adds no table or startup migration.

Rules:

- Two workers cannot own the same follow-up. A stale pre-send claim is retry-safe; a stale in-send claim is `Uncertain`.
- The state is persisted as `Sending` before Telegram is called. A crash after a possible send is never auto-retried.
- Telegram 429 is transient with bounded exponential backoff. Definitive 4xx rejection is terminal. Network ambiguity is `Uncertain`.
- `FOLLOWUP_MAX_ATTEMPTS` bounds retries. A successful delivery increments the existing count once and stores the exact delivery ID.
- Registration completion or a terminal lead status cancels a pre-send delivery and invalidates its token.
- Lead audit updates use the stable delivery ID, so a restart cannot increment agent-action counters twice.
- Tests use Telegram doubles only; no applicant receives a message.

Settings:

- `FOLLOWUP_CLAIM_LEASE_MS`: 30 seconds–1 hour, default 5 minutes.
- `FOLLOWUP_MAX_ATTEMPTS`: 1–10, default 3.
- `FOLLOWUP_RETRY_BASE_MS`: 1 second–1 hour, default 5 minutes.
- `FOLLOWUP_RETRY_MAX_MS`: 1 second–24 hours, default 1 hour and not less than the base.

`followup_scheduler_run` logs aggregate recovered, claimed, sent, retry-wait, uncertain, failed, and duplicate-prevention counts. It never logs recipient IDs or message text. Any `Uncertain > 0` requires evidence review; `Failed > 0` requires operator investigation.
