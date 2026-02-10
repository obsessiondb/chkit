# CHX JSON Output Contract (v1)

This document defines machine-readable CLI output when `--json` is used.

## Envelope

All JSON payloads include:

1. `command`: source command (`generate`, `migrate`, `status`, `drift`, `check`)
2. `schemaVersion`: contract version number (current: `1`)

## Success Payloads

### `generate`

Normal mode keys:

1. `command`
2. `schemaVersion`
3. `migrationFile`
4. `snapshotFile`
5. `definitionCount`
6. `operationCount`
7. `riskSummary`

Plan mode (`--plan`) keys:

1. `command`
2. `schemaVersion`
3. `mode`
4. `operationCount`
5. `riskSummary`
6. `operations`

### `status`

Keys:

1. `command`
2. `schemaVersion`
3. `migrationsDir`
4. `total`
5. `applied`
6. `pending`
7. `pendingMigrations`
8. `checksumMismatchCount`
9. `checksumMismatches`

### `migrate`

Plan/no-execute keys:

1. `command`
2. `schemaVersion`
3. `mode`
4. `pending`

No-pending execute keys:

1. `command`
2. `schemaVersion`
3. `mode`
4. `pending`
5. `applied`

Execute success keys:

1. `command`
2. `schemaVersion`
3. `mode`
4. `applied`
5. `journalFile`

### `drift`

Keys:

1. `command`
2. `schemaVersion`
3. `snapshotFile`
4. `expectedCount`
5. `actualCount`
6. `drifted`
7. `missing`
8. `extra`
9. `kindMismatches`
10. `objectDrift`
11. `tableDrift`

### `check`

Keys:

1. `command`
2. `schemaVersion`
3. `strict`
4. `policy`
5. `ok`
6. `failedChecks`
7. `pendingCount`
8. `checksumMismatchCount`
9. `drifted`
10. `driftEvaluated`
11. `driftReasonCounts`
12. `driftReasonTotals`

## Error Payloads

### `generate` validation error

Keys:

1. `command`
2. `schemaVersion`
3. `error` (`validation_failed`)
4. `issues`

### `migrate` checksum mismatch error

Keys:

1. `command`
2. `schemaVersion`
3. `mode`
4. `error`
5. `checksumMismatches`

### `migrate` destructive migration blocked error

Keys:

1. `command`
2. `schemaVersion`
3. `mode`
4. `error`
5. `destructiveMigrations`
6. `destructiveOperations`

`destructiveOperations` item keys:

1. `migration`
2. `type`
3. `key`
4. `risk`
5. `warningCode`
6. `reason`
7. `impact`
8. `recommendation`
9. `summary`

## Exit Codes

1. `0`: success
2. `1`: generic command failure, validation failure, or policy failure
3. `3`: destructive migrate blocked by the safety gate (`migrate --execute` with pending `risk=danger` migration(s) and no `--allow-destructive`)

## Compatibility Policy

1. Existing keys/meanings are stable for `schemaVersion = 1`.
2. Renames/removals or meaning changes require a schema version bump.
3. Additions should remain backward-compatible and be documented here.
4. CLI tests should fail when stable top-level key sets change unexpectedly.
