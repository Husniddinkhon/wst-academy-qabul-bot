# Wave 3 webhook retry and dead-letter policy

Every failed delivery keeps its original `Idempotency-Key` and a stable local failure ID. Backward-compatible records are normalized on read.

## Lifecycle

- HTTP 408, 429, and 5xx responses are definite transient failures and enter `RetryWait`.
- Other HTTP 4xx responses enter terminal `DeadLetter`.
- Timeout, connection loss, or an interrupted retry enters `Uncertain`; it is never automatically sent again.
- Claims are token-owned with a lease. An expired in-flight claim becomes `Uncertain` because the receiver might have processed it.
- Backoff is exponential and capped. `WEBHOOK_MAX_ATTEMPTS` creates an audited `webhook_retry_exhausted` dead letter.
- Records are retained only until `retainedUntil`. Expiry removal emits an aggregate `webhook_retention_expired` event and no applicant or endpoint data.
- Successful retry removes the failure record only after a definitive 2xx response.

Settings:

- `WEBHOOK_MAX_ATTEMPTS`: 1–20, default 5.
- `WEBHOOK_RETENTION_MS`: 1–30 days, default 7 days.
- `WEBHOOK_RETRY_BASE_MS`: 1 second–1 hour, default 1 minute.
- `WEBHOOK_RETRY_MAX_MS`: 1 second–24 hours, default 1 hour and not less than the base.
- `WEBHOOK_CLAIM_LEASE_MS`: 30 seconds–1 hour, default 10 minutes.
- `WEBHOOK_MAX_MANUAL_REPLAYS`: 1–3, default 1.

## Operator procedure

1. `/webhook_failures` lists only stable failure ID, state, attempts, and retention deadline.
2. `/retry_webhooks` claims only due `RetryWait` records and preserves their original semantic identity.
3. A flat configured admin may use `/replay_webhook <id> <reason>` for a retained `DeadLetter` or `Uncertain` record. The current Wave 3 scope does not redesign RBAC; that remains a release blocker.
4. Manual replay requires an actor, a reason of at least eight characters, and an available manual-replay allowance. Actor and reason are stored in the private audit file but not printed in structured logs.
5. Exhausted or expired entries are never silently retried. Retention expiry and manual replay produce aggregate structured events.

`webhook_retry_run` logs only attempted, sent, remaining, and aggregate state counts. Alert thresholds are: any `Uncertain` or `DeadLetter` requires review; RetryWait older than two backoff windows indicates delivery/operator failure; retention-expiry counts should be reconciled with the operations report.

## Rollback

Do not downgrade a live queue to Wave 2 code: it would not enforce `nextRetryAt`, attempt ceilings, dead letters, or retention. A future staging rollback must stop the bot, preserve the valid Wave 3 JSON generations, and use an owner-reviewed compatibility conversion. No rollback, migration, deployment, or production file edit occurred in Wave 3.
