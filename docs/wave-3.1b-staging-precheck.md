# Wave 3.1B secure staging precheck

This runbook authorizes only local configuration validation and the Telegram read-only methods `getMe`, `getChat`, and `getChatMember`. It does not authorize polling, webhook mutation, message publication, message editing/deletion, deployment, merge, or push.

## Secret and process boundary

Create `.env.staging.local` locally, keep its ACL restricted to the current Windows owner, and never place values in shell arguments, Git, reports, or ordinary logs. The file must contain exactly:

- `NODE_ENV=staging`;
- staging-only `BOT_TOKEN`, private `CHANNEL_CHAT_ID`, and `ADMIN_IDS`;
- `ACADEMY_DATA_DIR=./.staging-data`;
- `ACADEMY_MEDIA_DIR=./.staging-media`;
- `ACADEMY_BACKUP_DIR=./.staging-backups`.

The precheck rejects missing, duplicate, unknown, malformed, escaping, or conflicting values. It also rejects inherited database, webhook, AI, reporting, discussion-chat, and aggregate-service targets. The secret file is loaded only inside the short-lived precheck process.

## Fail-closed staging rules

`loadConfig()` requires an explicit staging channel and admin list. The production-compatible default channel is never used in staging. Individual state-file overrides and `DATABASE_URL` are prohibited for this local precheck; all runtime JSON paths derive from `.staging-data`, media resolves under `.staging-media`, and `.staging-backups` is reserved for staging-only snapshots. These directories and `.env.staging.local` are Git-ignored.

A future application startup with the validated environment emits an aggregate `STAGING MODE` identity without bot, channel, admin, token, or applicant identifiers.

## Read-only command

From the repository root:

```powershell
npm.cmd run staging:precheck
```

The command creates the three ignored staging directories and performs only:

1. `getMe` to validate the bot;
2. `getChat` to prove the configured target is a reachable private channel;
3. `getChatMember` to prove the bot can post and each configured staging admin administers the channel.

Its JSON result contains SHA-256 fingerprints, booleans, counts, and permission flags only. Raw tokens, IDs, usernames, channel titles, and Telegram error descriptions are never printed. The command contains no polling or mutating Telegram method.

## Fingerprint interpretation

- Bot identity: SHA-256 of the numeric identity returned by `getMe`.
- Bot username: SHA-256 of the returned username.
- Channel identity: SHA-256 of the channel ID returned by `getChat`.
- Admin identity set: SHA-256 of sorted configured admin IDs joined with commas.

Fingerprints prove repeatability without disclosing raw identifiers. Production identity comparison remains owner-attested unless separately supplied as a fingerprint; this precheck never reads production credentials.

## Next boundary

A passing precheck permits Wave 3.1 controlled staging QA to be planned. It does not itself authorize a post. Message publication, polling, webhook changes, and applicant workflows remain prohibited until the owner explicitly starts the next wave.
