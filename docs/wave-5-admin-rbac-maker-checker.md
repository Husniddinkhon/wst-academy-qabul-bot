# Wave 5 admin and admissions authorization

Wave 5 replaces flat `ADMIN_IDS` runtime authority with a durable, default-deny authorization ledger. The implementation and migration are local only; no production file, service, Telegram bot, applicant, channel, or database was changed.

## Identity, roles, and scopes

Only the authoritative Telegram sender in the same private chat can authenticate. Usernames, display names, forwarded identities, group membership, callback fields, and a configured ID list are not authorization evidence. `ADMIN_IDS` is read only for a one-time bootstrap when the authorization ledger has no actors or assignments. Subsequent configuration changes cannot grant, retain, or restore access.

The explicit roles are `OWNER`, `ADMISSIONS_MANAGER`, `ADMISSIONS_OPERATOR`, `REVIEWER`, `PUBLISHER`, `FOLLOWUP_OPERATOR`, `AUDITOR`, and `SUPPORT_READONLY`. Permissions are granular across masked/sensitive applicant reads, applicant review/update/block/merge/consent/audit/export, publication create/approve/publish/reconcile, follow-up create/approve/send/cancel, webhook/dead-letter operations, role administration, and system audit.

Assignments have effective and optional expiry times and one or more resource scopes. Scopes can cover all resources, assigned resources, selected resource/program/region/channel/campaign sets, or audit-only access. Every command reauthorizes against current durable state, so role revocation or expiry immediately blocks later execution and automated notification eligibility.

## Authorization order and data minimization

Privileged handlers derive the actor, load durable state, require an active assignment, check the exact permission and resource scope, enforce maker-checker when required, validate the request, execute, then record privacy-safe audit evidence. Denials are non-disclosing and rate-limited in the authorization audit.

Applicant lists, alerts, registration notifications, call-request notifications, and ordinary `/lead <applicant_ref>` responses are masked by default and use stable hashed applicant references. `/lead_sensitive <applicant_ref> <purpose>` requires the separate sensitive-view permission, an exact applicant scope, a stated purpose, and an authorization audit entry. Export uses a separate permission and maker-checker approval; a selected-resource assignment cannot export the all-applicant CSV. The immutable export approval names the minimal operational allowlist: opaque applicant/lead references, record timestamps, lifecycle statuses, source, campaign reference, and payment status. The generated CSV omits Telegram IDs/usernames, raw names and phone numbers, private application answers, conversation messages, AI reasons, operator notes, registration notes, and unrestricted free text.

## Maker-checker

The approval ledger covers applicant merge/export/block, publication approval/publish/reconciliation, follow-up send, dead-letter replay, role assignment/revocation, and the destructive publication controls currently exposed by Telegram commands. An approval binds the action, normalized resource digest, canonical request digest, version, maker, different approver, expiry, state, and a non-sensitive summary. Changed payloads or versions fail, expired or revoked requests fail, and a consumed request cannot be reused.

`/approvals` exposes only non-sensitive summaries and digests. `/approve <approval_id>` and `/reject <approval_id>` reauthorize the current actor. The maker must repeat the original command with the approved ID; consumption rechecks the maker, approver, executor, permissions, scopes, payload, version, state, and expiry. An `OWNER` cannot approve their own action.

Role assignment and revocation use the same bound approval primitive. Self-assignment, self-elevation, self-revocation, duplicate active assignment, invalid scope, and removal of the last active `OWNER` fail closed. Role-target Telegram IDs are hashed in approval resources and payloads.

`/roles` lists opaque actor/assignment references and scope classes. `/role_assign` supports all, audit-only, assigned-resource, and selected resource/program/region/channel/campaign scopes; `/role_revoke` removes an assignment immediately. Both mutation commands require a second actor's approval and repeat the original bound command before execution.

## Callback safety

Privileged callback intents are stored durably and encoded as compact HMAC-signed, versioned payloads. The stored intent binds actor, permission, action, resource, expiry, and state. Consumption verifies the signature, exact actor, current authorization, expiry, and one-time use; forged, cross-actor, expired, revoked-role, or replayed callbacks fail closed. Existing public informational callbacks are outside the privileged callback path.

## Storage, compatibility, and rollback

The authorization ledger defaults to `data/authorization.json` and staging derives `.staging-data/authorization.json`; staging forbids inherited path overrides. It uses the existing token-owned file lock and generation-safe atomic JSON writer. Missing or legacy unversioned state migrates in memory to schema v1, duplicate actor/Telegram identities are revoked rather than merged, and unknown future versions fail closed. `rollbackAuthorizationDatabase` produces the previous unversioned shape. Concurrent approvals and role changes serialize under the same lock.

Authorization audit records contain internal actor IDs, roles, permission, scope class, action/decision, maker/approver/approval references, version, request digest, timestamp, and hashed correlation. They exclude tokens, raw Telegram IDs, full phone numbers, names, usernames, free text, callback secrets, and raw payloads.

## Release boundary

Wave 5 resolves P1-07 only in the local repair branch. P1-09 through P1-12 remain release blockers. Production release additionally requires an owner-controlled migration and recovery plan for the existing production identities; this wave does not deploy, start polling, publish, send messages, modify production state, or change services.
