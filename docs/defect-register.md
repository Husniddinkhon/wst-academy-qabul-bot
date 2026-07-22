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

## Wave 5 resolved in the local repair branch

| ID | Severity | Defect | Resolution evidence | Status |
|---|---|---|---|---|
| P1-07 | P1 | Flat `ADMIN_IDS` granted PII, admissions, approval, publishing, retry and export privileges | Durable default-deny roles/scopes, private authoritative actor, masked default views, bound maker-checker, signed callbacks, immediate revocation and privacy-safe allow/deny audit; `tests/authorization.test.ts`, `tests/channelAdminAuth.test.ts` | Resolved locally; not deployed |

Wave 5.1 controlled staging QA found that the approved CSV allowlist still included raw contact details and private application answers. The staging-only repair reduced the immutable allowlist to opaque references, timestamps, lifecycle statuses, source/campaign references and payment status; focused export tests now reject raw names, phone numbers and application answers. Production remains unchanged and the repair is not deployed.

## Resolved in the local repair branch

| ID | Severity | Defect | Resolution evidence | Status |
|---|---|---|---|---|
| P1-12 | P1 | Backup/restore, off-host retention and RPO/RTO not proven by a restore rehearsal | `src/backupManifest.ts`: SHA-256 checksummed manifests, AES-256-GCM encrypted off-host copy; `src/backupRehearsal.ts`: full rehearsal CLI; `tests/backupRehearsal.test.ts`: 10 tests covering discovery, manifest, encryption round-trip, off-host copy/restore, hash verification, cleanup | Resolved locally; not deployed |
| P1-11 | P1 | Deployment rollback backed up the newly built candidate rather than the previous release | `scripts/deploy-guard.sh`: backup moved before `npm ci`+`npm run build`; rollback guards against missing backup; `tests/deploymentConfig.test.ts` | Resolved locally; not deployed |
| P1-09 | P1 | Generic webhook and AI endpoints allow unsafe egress configuration | Outbound egress policy commit `5afd576` | Resolved locally; not deployed |
| P1-10 | P1 | Database DDL/import runs during application startup | Migration engine commit `a41e448` | Resolved locally; not deployed |

## Wave 3.1B staging precheck resolved locally

| ID | Severity | Defect | Resolution evidence | Status |
|---|---|---|---|---|
| STG-01 | P1 | Staging could inherit the production-compatible channel fallback or non-isolated state targets | Explicit staging channel/admin requirements, isolated `ACADEMY_*` paths, inherited-target rejection, visible non-secret `STAGING MODE`, and read-only allowlisted Telegram preflight; `tests/config.test.ts`, `tests/stagingConfig.test.ts`, `tests/stagingTelegramPreflight.test.ts` | Resolved locally; not deployed |

## Wave 4 resolved in the local repair branch

| ID | Severity | Defect | Resolution evidence | Status |
|---|---|---|---|---|
| P1-06 | P1 | Applicant identity relied directly on Telegram ID and registration/follow-up consent was not affirmative or purpose-specific | Internal applicant UUID ledger, authoritative private Telegram actor, versioned separate application/outbound/follow-up grants, withdrawal/anonymization, lifecycle and merge-review gates; `tests/applicantIdentity.test.ts` | Resolved locally; not deployed |
| P1-08 | P1 | Applicant inputs and contact ownership were weakly validated | Self-shared contact ownership match, forwarded/typed/mismatch rejection, normalized phone, bounded Unicode/markup/command/path validation, data minimization and audit redaction; `tests/applicantValidation.test.ts`, `tests/applicantIdentity.test.ts` | Resolved locally; not deployed |

## Release qualification

Wave 5 completion together with P1-09 (egress), P1-10 (migration engine), P1-11 (deployment rollback), and P1-12 (backup rehearsal) qualifies the local RBAC, scope, maker-checker, callback, masking, revocation, authorization-audit, egress, migration, rollback, and backup controls for controlled staging QA. It does not make the bot production-ready or authorize deployment.
