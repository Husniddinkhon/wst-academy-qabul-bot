# WST Academy Telegram defect register

Severity uses P0 Critical, P1 High, P2 Medium, and P3 Low. Closed entries require code evidence and regression tests; deployment status is tracked separately.

## Wave 1 resolved in the local repair branch

| ID | Severity | Defect | Resolution evidence | Status |
|---|---|---|---|---|
| W1-01 | P2 | Runtime `.bak`, lock-directory, and temporary files appeared as untracked Git changes | `.gitignore`; `tests/deploymentConfig.test.ts` | Resolved locally; not deployed |
| W1-02 | P1 | Stale lock takeover and owner-blind release could remove a successor lock | Fixed exclusive reclaim claim; live/dead/dual-reclaimer/successor tests | Resolved locally; not deployed |
| W1-03 | P1 | A corrupt primary could overwrite the only good `.bak`; a missing primary ignored `.bak` | Parseable generations, fail-closed I/O, recovery-order, and interruption tests | Resolved locally; not deployed |
| W1-04 | P2 | Idempotent operational-alert checks physically rewrote unchanged state every minute | Serialized change detection and no-op persistence test | Resolved locally; not deployed |

## Preserved P1 backlog for later controlled waves

| ID | Defect | Required future control | Wave 1 disposition |
|---|---|---|---|
| P1-01 | Telegram updates lack durable `update_id` and side-effect idempotency | Durable bounded update ledger and stable keys for notifications/webhooks/admin mutations | Preserved; out of scope |
| P1-02 | Telegram publication has no safe uncertain-outcome reconciliation | Explicit outcome-unknown state, evidence reconciliation, send deadlines, classified bounded retries | Preserved; out of scope |
| P1-03 | Publisher shutdown does not drain in-flight work | Stop claims first, bounded drain, durable attempt outcome | Preserved; out of scope |
| P1-04 | Follow-up messages lack durable claims and can duplicate | Per-recipient leases, idempotency keys, terminal states | Preserved; out of scope |
| P1-05 | Failed-webhook retry can erase concurrently appended failures | Per-item claim/finish outbox with bounded retry and retention | Preserved; out of scope |
| P1-06 | Applicant identity relies on Telegram ID and registration consent is not affirmative | Owner-approved person/application identity, versioned consent and deletion/correction controls | Preserved; admissions redesign prohibited in Wave 1 |
| P1-07 | Flat `ADMIN_IDS` grants PII, admissions, approval, publishing, retry and export privileges | Default-deny roles, private-chat enforcement, maker-checker and actor audit | Preserved; role redesign prohibited in Wave 1 |
| P1-08 | Registration state is volatile and applicant inputs/contact ownership are weakly validated | Durable conversation state and bounded canonical validation | Preserved; admissions redesign prohibited in Wave 1 |
| P1-09 | Generic webhook and AI endpoints allow unsafe egress configuration | HTTPS-only host allowlists, credential/private-network rejection, signed versioned connectors | Preserved; integration changes prohibited in Wave 1 |
| P1-10 | Database DDL/import runs during application startup | Separate owner-controlled migration command and rollback gate | Preserved; database migration prohibited in Wave 1 |
| P1-11 | Deployment rollback backs up the newly built candidate rather than the previous release | Immutable release directories or verified pre-build snapshot and atomic switch | Preserved; deployment changes deferred |
| P1-12 | Backup/restore, off-host retention and RPO/RTO are not proven by a restore rehearsal | Checksummed manifests, encrypted off-host copy and isolated restore exercise | Preserved; production backup mutation prohibited |

## Release qualification

Wave 1 completion qualifies only the local storage-reliability repair for the next review wave. It does not make the bot production-ready or authorize deployment. Every open P1 above remains a release blocker until its own controlled repair and verification gate passes.
