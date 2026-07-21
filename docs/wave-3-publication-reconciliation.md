# Wave 3 channel publication reconciliation

This specification describes the local Wave 3 controls. It does not authorize a deployment, a Telegram post, or a production data migration.

## Compatible state machine

Existing PascalCase file states remain valid. New fields are additive, so a Wave 2 JSON file is normalized on read without an in-place migration.

| State | Meaning | Automatic next action |
|---|---|---|
| `Draft` | Content exists but is not scheduled | Admin approval or direct admin publish |
| `PendingApproval`, `Approved` | Reserved compatibility states for separated review workflows | None in Wave 3 |
| `Scheduled` | Approved and waiting for due time | Token-owned claim |
| `Claimed` | A worker owns a lease; Telegram send has not started | Renew, start send, cancel, or safe stale recovery |
| `Publishing` | Request fingerprint was persisted before the Telegram call | Complete as `Published`, classify a definitive failure, or fail closed as `Uncertain` |
| `Published` | Telegram message ID is durable | Terminal; further claims are rejected |
| `Uncertain` | Telegram might have accepted the request | Evidence reconciliation only; never automatic resend |
| `RetryWait` | A definite retryable failure or proven pre-send interruption | Retry after `nextRetryAt` with the same semantic identity |
| `Failed` | Definitive terminal rejection or validation failure | Admin-reviewed retry only where duplicate risk is disproven |
| `Cancelled` | Claim was invalidated before send | Terminal unless explicitly rescheduled |

Each attempt stores the stable post ID and semantic key, target channel, random claim token, worker ID, lease expiry, attempt ID/number, claim and send timestamps, SHA-256 request fingerprint, observed Telegram message ID, classified failure, reconciliation deadline/status, next retry time, and bounded audit history. The fingerprint is a hash; logs do not contain post text, bot tokens, chat IDs, or applicant data.

## Claim and lease rules

- The JSON file lock serializes claim transitions. Only the persisted random claim token can start, renew, or finish that attempt.
- A valid claim cannot be taken by a second worker. Terminal and `Uncertain` posts cannot be claimed.
- Cancellation is permitted through `Claimed`; it clears the token. Cancellation after `Publishing` is rejected because the remote outcome may already exist.
- An expired `Claimed` lease with no `sendStartedAt` becomes `RetryWait`. An expired `Publishing` lease becomes `Uncertain` and is never auto-retried.
- A legacy Wave 2 `Publishing` record without lease metadata is also recovered as `Uncertain`; compatibility data cannot remain stranded or be treated as safe to resend.
- The active publisher renews its lease at `CHANNEL_CLAIM_RENEW_MS`; configuration requires this interval to be shorter than `CHANNEL_CLAIM_LEASE_MS`.

## Telegram limitation and reconciliation

Telegram Bot API does not provide a bot method to search channel history by request fingerprint or semantic idempotency key, and `sendMessage`/`sendPhoto` do not accept an application idempotency key. Therefore a timeout after request transmission cannot be proven published or unpublished by an automatic API query.

The safe process is:

1. Leave the post in `Uncertain`; do not use a generic retry.
2. Inspect the configured channel using an authorized human account and match the approved content/media and time window.
3. If the exact Telegram message ID is proven, run `/channel_reconcile <id> published <message_id> <note>`.
4. If evidence proves the post was not published, run `/channel_reconcile <id> not_published <note>`, then retry the resulting `RetryWait` post.
5. If neither outcome is provable before `CHANNEL_UNCERTAIN_WINDOW_MS`, the state changes to `manual_review_required` and remains fail-closed.
6. An exceptional resend without proof requires `/channel_retry <id> <reason>`. The actor, reason, original attempt, and unchanged semantic key are audited; an aggregate manual-override event is logged without actor/chat ID.

Known message IDs returned before a local completion failure are retained as evidence. The same exact attempt may complete an idempotent local reconciliation to `Published` when its Telegram response arrives late or after one transient local write failure; this does not issue another Telegram request. Persistent local failure preserves the observed message ID in `Uncertain`. A process crash between Telegram receiving the response and any local write can still lose that message ID; such a case correctly remains `Uncertain`.

## Error classification

- Local validation and Telegram 4xx rejection are definitive `Failed` outcomes.
- Telegram 429 enters bounded `RetryWait` using `retry_after`, capped at one hour.
- Timeout, reset, broken socket, unknown exception after send start, or local completion failure becomes `Uncertain`.
- Campaign expiry is a definitive local validation failure before Telegram send.
- Media sends use the same pre-send fingerprint and uncertainty rules as text sends.

## Metrics and alert thresholds

`/ops_report` and `/channel_report` expose aggregate Scheduled, due, Claimed, Publishing, Uncertain, RetryWait, Failed, Published, and Cancelled counts. `channel_scheduler_run` logs the same aggregate queue dimensions plus stale recovery and outcome counts.

Operational thresholds:

- `Uncertain > 0`: immediate human review; never automatic resend.
- `Publishing > 0` beyond one claim lease: stale-claim alert/recovery investigation.
- `Claimed > 0` beyond one lease: worker/lock investigation.
- due Scheduled or RetryWait work older than two scheduler polls: scheduler health investigation.
- `Failed > 0`: content, permissions, or Telegram rejection review.

The existing recipient-deduplicated operational alert now covers both recent `Failed` and `Uncertain` posts without including raw exception text.

## Rollback notes

No production rollback is performed in Wave 3. A future staging rollback must stop workers first and preserve the Wave 3 JSON files. Older code does not understand `Claimed`, `Uncertain`, or `RetryWait`; starting it against a Wave 3 state file could strand work or encourage unsafe manual retry. Roll back code only together with an owner-approved compatibility reader or a verified pre-Wave-3 state snapshot. Never overwrite the newest valid `.bak` generation.
