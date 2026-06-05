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

This port matches the upstream TypeScript chkit **1:1 for the core surface**:
the schema DSL, the canonicalization + diff + planner pipeline, the codec
parser/renderer, validation, and the five CLI commands above. The journal
lives in the same ClickHouse `_chkit_migrations` table as the TS version, so
both implementations can share a database without divergence.

**What is 1:1 today (covered by 271 ported tests + manual E2E against
ClickHouse 24.8):**

- `chkit.core` model, canonicalization, codec, planner, validation,
  snapshot, SQL rendering.
- `chkit init` — same scaffold filenames, schema location, config shape,
  next-steps message as TS.
- `chkit generate` — same SQL header format (`chkit-migration-format`,
  `cli-version`, etc.), per-operation comments, `safe_name`-based filenames,
  collision suffixes, `--name` / `--migration-id` / `--dryrun` flags.
- `chkit migrate` — plan-by-default, `--apply` / `--execute`,
  `--allow-destructive` (exit code 3 when blocked).
- `chkit status` — same output text, same fields in `--json`, same
  database-missing warning.
- `chkit check --strict` — same policy gates (`failOnPending`,
  `failOnChecksumMismatch`, `failOnDrift`).
- `chkit drift` — snapshot vs current-schema diff with TS-shape output.
- Journal table schema (`_chkit_migrations`,
  `ReplacingMergeTree(applied_at) ORDER BY (name)`), `CHKIT_JOURNAL_TABLE`
  override, checksum mismatch detection.

**What is intentionally out of scope for this first base** — these are
recorded in [PARITY.md](PARITY.md) and tracked for future releases:

- Plugins (`@chkit/plugin-codegen`, `plugin-pull`, `plugin-backfill`,
  `plugin-obsessiondb`) and the plugin runtime.
- `chkit query` and `chkit plugin` commands.
- `--table` scope filter on `generate` / `migrate` / `check` / `drift`.
- Rename mappings (`--rename-table`, `--rename-column`).
- Per-operation async tracking in the journal.
- Live-DB introspection in `drift` (column diff, settings diff, engine
  mismatch detection).
- Interactive confirm prompts in `migrate`.
- User profile config and ObsessionDB credentials layer.

See [PARITY.md](PARITY.md) for the full TS-vs-Python matrix and the rationale
behind each deferral.

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
