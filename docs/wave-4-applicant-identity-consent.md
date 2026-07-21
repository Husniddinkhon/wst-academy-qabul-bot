# Wave 4 applicant identity, consent, and validation

Wave 4 adds a durable applicant identity boundary without changing or migrating production state. The implementation is local-only until a separately authorized release.

## Identity and lifecycle

`JsonApplicantIdentityStore` writes `applicant_identities.json` through the existing token-owned lock and generation-safe JSON writer. An internal UUID is the stable applicant key. Telegram user ID and private chat ID are authoritative transport identities; username is mutable metadata, display names are not authorization identities, and phone alone is never identity proof.

The lifecycle is `NEW`, `CONSENT_REQUIRED`, `CONSENTED`, `IDENTITY_PENDING`, `VERIFIED`, `APPLICATION_DRAFT`, `SUBMITTED`, `WITHDRAWN`, `BLOCKED`, or `MERGE_REVIEW`. Invalid transitions fail closed. Duplicate Telegram/chat/phone evidence enters `MERGE_REVIEW`; no code path automatically merges or deletes records. A human merge-review request records a redacted audit event but still performs no merge.

Telegram cannot prove whether an account was deleted and later recreated behind the same numeric ID. The system therefore preserves the existing applicant, treats username changes only as metadata changes, requires current consent and a new verified self-contact after withdrawal, and routes any conflicting chat/phone evidence to review.

## Consent purposes

The bot presents short Uzbek notices and records an explicit button or wizard choice, exact notice text, version, timestamp, source, and applicant identity. No box is preselected. These purposes are independent:

- `application_processing`: required before collecting or submitting an application;
- `outbound_applicant_message`: required before a non-essential outbound applicant contact;
- `follow_up`: required together with outbound consent before an automated reminder;
- `public_applicant_data`: denied by default; Wave 4 adds no public applicant-data publication flow;
- `marketing`: denied by default; Wave 4 adds no marketing opt-in flow.

`/withdraw_consent` revokes every active grant, cancels follow-up delivery, clears direct identity contact metadata, anonymizes the legacy lead fields, and retains only the internal identity, Telegram audit linkage, consent versions/status, timestamps, event type, actor class, verification result, and hashed correlation/audit references. Essential in-session replies such as a withdrawal confirmation are allowed; proactive or non-essential messaging is not.

## Contact ownership

Phone input is normalized only to `+998XXXXXXXXX`. Registration and operator-call flows accept ownership only from Telegram contact sharing where `contact.user_id` equals the authoritative `ctx.from.id`. Forwarded contacts, missing contact owners, typed numbers, mismatches, spoofed payload fields, and third-party contacts are rejected. Duplicate verified phones move both identities to `MERGE_REVIEW`. Guardian or representative cases require a future audited human-review workflow; Wave 4 never treats them as self-owned contacts.

## Validation and minimization

Names, age, region text, email helpers, program allowlists, free text, messages, filenames, MIME types, Unicode, control/format characters, markup, shell operators, and traversal paths have explicit limits and allowlists. Material input is rejected rather than truncated. The current registration program is the fixed allowlisted `cctv` program and the branch is the single configured Academy location, so neither is accepted as uncontrolled user input.

Required application fields are full name, verified phone, age, region, and program. Experience, preferred time, notes, and email are optional. Passport, payment-card, credentials/passwords, medical, biometric, and unknown fields are rejected. Applicant uploads are not enabled; the filename/MIME validator is a fail-closed boundary for any future authorized upload flow.

Audit events contain only internal applicant ID, event type, consent version, verification result, actor class, timestamp, and a hashed correlation ID. Full phone numbers, usernames, free text, tokens, payloads, and message content are excluded. Masked display helpers expose only minimal suffixes.

## Storage compatibility and rollback

Missing identity storage loads as an empty schema-v1 ledger. Legacy unversioned ledgers load backward-compatibly in memory; the first mutation writes schema v1 through the existing atomic writer, preserving the prior generation in `.bak`. Unknown future schema versions fail closed. Duplicate legacy identities are marked `MERGE_REVIEW` in memory instead of being collapsed. `rollbackApplicantIdentityDatabase` creates an unversioned snapshot readable by both the migration helper and the Wave 4 loader. No production migration is run by this wave.
