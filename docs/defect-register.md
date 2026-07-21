# WST Academy Telegram defect register

Severity uses P0 Critical, P1 High, P2 Medium, and P3 Low. Closed entries require code evidence and regression tests; deployment status is tracked separately.

## Wave 1 resolved in the local repair branch

| ID | Severity | Defect | Resolution evidence | Status |
|---|---|---|---|---|
| W1-01 | P2 | Runtime `.bak`, lock-directory, and temporary files appeared as untracked Git changes | `.gitignore`; `tests/deploymentConfig.test.ts` | Resolved locally; not deployed |
| W1-02 | P1 | Stale lock takeover and owner-blind release could remove a successor lock | Fixed exclusive reclaim claim; live/dead/dual-reclaimer/successor tests | Resolved locally; not deployed |
| W1-03 | P1 | A corrupt primary could overwrite the only good `.bak`; a missing primary ignored `.bak` | Parseable generations, fail-closed I/O, recovery-order, and interruption tests | Resolved locally; not deployed |
| W1-04 | P2 | Idempotent operational-alert checks physically rewrote unchanged state every minute | Serialized change detection and no-op persistence test | Resolved locally; not deployed |

## Wave 2 resolved in the local repair branch

| ID | Severity | Defect | Resolution evidence | Status |
|---|---|---|---|---|
| P1-01 | P1 | Telegram updates lacked durable `update_id` and side-effect idempotency | Durable fingerprinted update journal, live-owner-safe update/session claims, ordered raw-update recovery, atomic session/terminal commit, explicit route/call labels, token-owned webhook retries, bounded exact-ID retention, stable mutation/outbound keys, and PostgreSQL replay results; `tests/telegramUpdates.test.ts`, `tests/webhook.test.ts`, `tests/postgres.test.ts` | Resolved locally; not deployed |

## Wave 3 resolved in the local repair branch

| ID | Severity | Defect | Resolution evidence | Status |
|---|---|---|---|---|
| P1-02 | P1 | Telegram publication had no safe uncertain-outcome reconciliation | Additive publication states, pre-send fingerprint, token lease, fail-closed `Uncertain`, human evidence reconciliation/override audit, rate-limit classification; `tests/channelPublisher.test.ts`, `tests/channelScheduler.test.ts` | Resolved locally; not deployed |
| P1-03 | P1 | Publisher shutdown did not drain in-flight work | Stop-claim-first runtime, bounded scheduler/publisher drain, pre-send release, in-send uncertainty, non-zero timeout exit; `tests/publisherShutdown.test.ts` | Resolved locally; not deployed |
| P1-04 | P1 | Scheduled follow-up delivery lacked per-recipient claims | Stable delivery ID, JSON/PostgreSQL token claims, pre-send state, retry ceiling, cancellation, restart/shutdown recovery; `tests/followups.test.ts`, `tests/postgres.test.ts` | Resolved locally; not deployed |
| P1-05 | P1 | Failed-webhook records lacked retention and retry ceilings | Stable failure identity, bounded backoff/retention/attempts, dead letter, fail-closed stale claim, authorized manual replay; `tests/webhook.test.ts` | Resolved locally; not deployed |

## Preserved P1 backlog for later controlled waves

| ID | Defect | Required future control | Current disposition |
|---|---|---|---|
| P1-06 | Applicant identity relies on Telegram ID and registration consent is not affirmative | Owner-approved person/application identity, versioned consent and deletion/correction controls | Preserved; admissions redesign excluded from Wave 3 |
| P1-07 | Flat `ADMIN_IDS` grants PII, admissions, approval, publishing, retry and export privileges | Default-deny roles, private-chat enforcement, maker-checker and actor audit | Preserved; RBAC and maker-checker excluded from Wave 3 |
| P1-08 | Applicant inputs and contact ownership are weakly validated | Bounded canonical validation and owner-approved contact rules; Wave 2 made wizard state durable without redesigning identity | Preserved; identity and input redesign excluded from Wave 3 |
| P1-09 | Generic webhook and AI endpoints allow unsafe egress configuration | HTTPS-only host allowlists, credential/private-network rejection, signed versioned connectors | Preserved; outbound egress controls excluded from Wave 3 |
| P1-10 | Database DDL/import runs during application startup | Separate owner-controlled migration command and rollback gate | Preserved; database migration redesign excluded from Wave 3 |
| P1-11 | Deployment rollback backs up the newly built candidate rather than the previous release | Immutable release directories or verified pre-build snapshot and atomic switch | Preserved; deployment changes deferred |
| P1-12 | Backup/restore, off-host retention and RPO/RTO are not proven by a restore rehearsal | Checksummed manifests, encrypted off-host copy and isolated restore exercise | Preserved; production backup mutation prohibited |

## Release qualification

Wave 3 completion qualifies only the local publication/follow-up/webhook reliability controls for controlled staging QA. It does not make the bot production-ready or authorize deployment. P1-06 through P1-12 remain release blockers until their own controlled repair and verification gates pass.
