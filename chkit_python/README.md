# chkit-py

A Python port of [chkit](https://chkit.obsessiondb.com) — ClickHouse schema
management and migration toolkit, written in strict, imperative Python.

## Install

```bash
pip install chkit-py
chkit --help
```

The package is named `chkit-py` on PyPI; the import name is `chkit`.

## Design

- **Type safety first.** Every public surface is annotated. Ships clean under
  `mypy --strict` and `pyright` strict mode.
- **Pydantic v2 models.** Runtime validation, frozen, `extra="forbid"`.
- **Imperative core.** Pure functions over data; minimal classes outside of
  Pydantic models and the CLI shell.
- **No magic.** No dynamic imports, no runtime introspection of user code
  beyond what Pydantic provides.

## Layout

```
src/chkit/
  core/          Schema DSL, diff engine, planner, SQL rendering, validation
  clickhouse/    ClickHouse client wrapper
  cli/           Typer-based CLI (init, generate, migrate, status, check, drift)
```

## Quickstart

In a fresh project:

```bash
pip install chkit-py
chkit init                           # scaffold clickhouse.config.py + example schema
chkit generate --name init           # diff schema vs snapshot -> writes migrations/*.sql
chkit migrate --apply                # apply pending, journal in ClickHouse _chkit_migrations
chkit status                         # show applied / pending counts
chkit check --strict                 # CI gate (pending, drift, checksum)
chkit drift                          # snapshot vs current schema diff
```

`clickhouse.config.py` reads its credentials from `os.environ.get(...)` by
default. Set `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`,
`CLICKHOUSE_DB` (or override directly in the config).

## TypeScript parity

This port matches the upstream TypeScript chkit on every user-facing
surface: schema DSL, canonicalization + diff + planner pipeline, codec
parser/renderer, validation, all CLI commands, the plugin runtime + its
hooks, and every first-party plugin. The journal lives in the same
ClickHouse `_chkit_migrations` table as the TS version, so both
implementations can share a database without divergence.

**Covered — 1:1 with TS:**

- `chkit.core` — model, canonicalization, codec, planner, validation,
  snapshot, SQL rendering, `apply_on_cluster_to_plan`. Includes the
  Dictionary primitive (`dictionary()` — full lifecycle: DSL,
  validation, diff/replace planning, `--rename-dictionary`, pull
  introspection, codegen), index-only projections, and function
  expressions in `primaryKey`/`orderBy`.
- All CLI commands: `init`, `generate`, `migrate`, `status`, `check`,
  `drift` (with live-DB compare), `pull`, `query`, `plugin`. Codegen
  runs automatically after `chkit generate` when the plugin is
  registered (via the `on_plan_created` hook).
- Flag surface — `--rename-table` / `--rename-column`, `--table
  <selector>` on generate/migrate/status/check/drift, `--dryrun` /
  `--json` / `--config`, `--strict`, `--apply` / `--execute` /
  `--allow-destructive` (exit code 3 when blocked).
- Plugin runtime + all hooks (`on_config_loaded`, `on_schema_loaded`,
  `on_plan_created`, `on_before_apply`, `on_after_apply`, `on_check`,
  `on_check_report`, `on_before_plugin_command`, `on_pull_introspect`,
  `on_init`, `on_complete`).
- First-party plugins: `chkit_plugin_codegen` (Pydantic model
  generator, including dictionary attribute models),
  `chkit_plugin_obsessiondb` (auth, service management, remote
  executor, backfill routing, `Shared*`-engine rewrites),
  `chkit_plugin_backfill` (full chunking + execution engine: smart
  size-aware chunk planning, async submit/poll execution loop with
  checkpoint + resume, mv_replay detection, and the managed-job
  `submit` path via ObsessionDB).
- Journal — `_chkit_migrations` table (schema + `CHKIT_JOURNAL_TABLE`
  override + checksum mismatch detection), per-operation async
  tracking, `INSERT race condition` retry, ON CLUSTER +
  `ReplicatedReplacingMergeTree` engine when cluster mode is enabled.
- `ON CLUSTER <name>` support — set `clickhouse.cluster` and every
  generated DDL statement is stamped as a final plan post-pass.

**Not ported by design** — Python convention or ecosystem difference:

- `chkit skills` proxy (no `npx` analogue), `create-chkit` separate
  scaffolder (use `chkit init --example <name>` instead), `deps.ts`
  auto-install (Python convention is explicit `pip install`),
  `internal-plugins/skill-hint` AI-agent detection.

See [DRIFT.md](DRIFT.md) for the append-only decision log covering every
port choice, known limitation, and won't-port item.

## Development

```bash
git clone https://github.com/obsessiondb/chkit
cd chkit_python
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
.venv\Scripts\python.exe -m pytest
.venv\Scripts\python.exe -m mypy src
.venv\Scripts\python.exe -m ruff check src tests
```

Tests under `tests/test_*_parity.py` and `tests/test_sql_validation_e2e.py`
are direct ports of the TS suites in
`packages/core/src/*.test.ts`. The E2E suite requires a reachable ClickHouse
(defaults to `http://localhost:8123` with no password — matches a fresh
`docker run` of clickhouse-server). Override via `CLICKHOUSE_URL` /
`CLICKHOUSE_PASSWORD`.
