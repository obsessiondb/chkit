# Validation TODO (Post-Server Bring-Up)

This tracks deferred validation items while ClickHouse infrastructure is being prepared.

## Deferred E2E Validation
1. Run full loop against live ClickHouse:
   - `chx init`
   - `chx generate`
   - `chx migrate --plan`
   - `chx migrate --execute`
   - `chx status`
2. Validate migration journal integrity:
   - checksum mismatch detection behaves as expected
   - per-migration journaling survives partial failure
3. Validate JSON output contracts for automation/CI:
   - `chx generate --plan --json`
   - `chx migrate --plan --json`
   - `chx migrate --execute --json`
   - `chx status --json`
4. Validate Phase 1 exit criteria with two demo projects end-to-end.

## Automated E2E Env Validation
1. Configure Doppler project/config with ClickHouse credentials:
   - project: `chx`
   - config: `e2e`
   - required secrets:
     - `CLICKHOUSE_HOST`
     - `CLICKHOUSE_PASSWORD`
     - optional: `CLICKHOUSE_URL`, `CLICKHOUSE_USER`
2. Run live env tests:
   - `bun run test:env`
3. The env test validates this flow against live ClickHouse:
   - `chx init`
   - `chx generate --json`
   - `chx migrate --plan --json`
   - `chx migrate --execute --json`
   - `chx status --json`

## Notes
1. Lint, unit tests, and typecheck are currently green.
2. ClickHouse-backed execution is intentionally deferred until server setup is complete.
