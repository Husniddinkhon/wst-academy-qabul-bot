# Wave 1 storage reliability

## Scope and safety boundary

Wave 1 changes only repository-local JSON storage primitives, runtime-artifact ignore rules, and tests. It does not change admissions behavior, database ownership, Telegram configuration, production services, runtime data, deployment, or integrations.

Production primary JSON files and their recovery generations must never be copied into Git. The protected runtime set is:

- `data/*.json` — authoritative primary state;
- `data/*.json.bak` — most recent verified primary generation;
- `data/*.json.bak.1` — preceding verified generation;
- `data/*.json.lock/` — active token-owned lock directory;
- `data/*.json.lock/.reclaim-*` — short-lived tokenized stale-reclamation marker;
- `data/*.json.*.tmp` — uncommitted durable-write candidates.

## Token-owned lock protocol

Each writer acquires `<state>.lock/` with an atomic directory creation. The directory contains `owner.json` with a random token, PID, and creation time.

- A writer releases a lock only when the on-disk token still matches its token.
- A lock older than five minutes is not reclaimed while its recorded PID is alive.
- A reclaimer creates a unique marker inside the observed lock directory and then rechecks ownership before removal.
- Release detects reclamation markers and cannot race a stale takeover; abandoned markers are cleaned only after the old owner record is gone.
- An old writer cannot remove a successor's lock.
- A PID-reuse false positive safely blocks reclamation instead of permitting concurrent writers.

Lock timeout remains a fail-closed condition. Operators must not manually remove a lock merely because it is old; process ownership must be established first.

## Generation-safe write protocol

`atomicWriteJson` writes and fsyncs a `0600` candidate before changing recovery state.

When the primary is valid JSON:

1. Write and fsync a backup candidate containing the current primary.
2. Move a valid `.bak` generation to `.bak.1`.
3. Commit the candidate as `.bak`.
4. Fsync the directory on platforms that support directory fsync.
5. Rename the new primary candidate over the authoritative primary.
6. Fsync the directory again.

When the primary is corrupt or missing, it is never copied over a valid backup. The new primary is committed while existing valid generations remain unchanged.

Recovery read order is:

1. primary;
2. `.bak`;
3. `.bak.1`;
4. empty/default state only when the primary and all backup generations are absent.

If the primary exists but no parseable generation exists, startup or the calling operation fails closed with a storage-read error.

## Operational-alert no-op behavior

Operational-alert mutations compare serialized state before and after the mutation. An already-delivered alert, active cooldown, or other idempotent operation no longer rewrites the primary or rotates backup generations. Real changes, retention pruning, claims, delivery completion, and retry scheduling still persist normally.

## Verification

Focused verification:

```powershell
npx.cmd tsx --test tests/safeJsonRecovery.test.ts tests/operationalAlerts.test.ts tests/deploymentConfig.test.ts
```

Full repository verification:

```powershell
npm.cmd test
npm.cmd run build
```

Tests use isolated temporary directories and never point at production paths.

## Recovery and rollback guidance

Before any future storage-format deployment, preserve the primary, `.bak`, and `.bak.1` together with hashes and metadata outside the application repository. Rollback must restore a verified matched set while the application is stopped under a separately approved production procedure.

This wave does not authorize deletion of legacy `.bak` files, stale worktree metadata, live locks, production data, or backup generations.
