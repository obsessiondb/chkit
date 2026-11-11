"""Journal reads under ``date_time_output_format`` (#672).

Port of ``packages/cli/src/test/journal-store-output-format.e2e.test.ts``: a
user profile can set ``date_time_output_format``, which changes how a
DateTime64 is rendered inside ``toJSONString``. The journal reads its times the
same way under every format. Runs against the server in ``CLICKHOUSE_URL`` /
``CLICKHOUSE_HOST``; an unreachable server fails the test.
"""

from __future__ import annotations

from chkit.cli.journal_store import JournalStore, MigrationRowState, OperationState
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import create_prefix, quote_ident, resolve_live_env


def _connect(database: str, settings: dict[str, str] | None = None) -> ClickHouseClient:
    env = resolve_live_env()
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=database,
        secure=env.clickhouse_url.startswith("https:"),
    )
    options = {"settings": settings} if settings else {}
    return ClickHouseClient(ClickHouseClient._open_driver(config, **options), config)


def test_journal_reads_times_in_one_format_under_unix_timestamp() -> None:
    env = resolve_live_env()
    database = f"{create_prefix('py_journal_fmt')}db"
    admin = _connect(env.clickhouse_database)
    admin.execute(f"CREATE DATABASE {quote_ident(database)}")
    client = _connect(database, {"date_time_output_format": "unix_timestamp"})
    try:
        probe = client.query(
            "SELECT toJSONString(toDateTime64('2026-05-26 10:00:00.123', 3, 'UTC')) AS t"
        ).rows[0]["t"]
        # The setting reaches the server: without the fix the journal reads this form.
        assert probe == '"1779789600.123"'

        state = MigrationRowState(
            name="m.sql",
            applied_at="2026-05-26T10:00:01.000",
            checksum="abc",
            chkit_version="",
            migration_completed=False,
            operations=[
                OperationState(
                    operation_index=0,
                    operation_key="table:t",
                    operation_type="load_table_data",
                    query_id="q",
                    status="started",
                    started_at="2026-05-26T10:00:00.123",
                    finished_at=None,
                    last_error="",
                    fingerprint="",
                )
            ],
        )
        JournalStore(client).write_migration_state(state)

        read = JournalStore(client).read_migration_state("m.sql")
        assert read is not None
        assert read.applied_at == "2026-05-26 10:00:01.000"
        assert read.operations[0].started_at == "2026-05-26 10:00:00.123"
    finally:
        admin.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        client.close()
        admin.close()
