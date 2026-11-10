"""The journal while ``CREATE DATABASE`` is still reaching replicas (#493).

The client retries a statement that fails with UNKNOWN_DATABASE without the
database, so an unqualified journal ``CREATE`` that reaches a replica without
the new database yet would create the journal in the server's default database.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

import pytest

from chkit.cli.journal_store import JournalStore, MigrationRowState
from chkit.clickhouse.client import ClickHouseClient, QueryResult, is_unknown_database_error
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    poll_until,
    quote_ident,
    resolve_live_env,
)

# Where the client's retry without the database runs a statement.
_SERVER_DEFAULT_DATABASE = "default"
_PROBE_PREFIX = "SELECT name, migration_completed, operations FROM "


def _connect(database: str) -> ClickHouseClient:
    env = resolve_live_env()
    return ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    )


class _LaggingReplicaClient:
    """The target as a multi-replica server looks right after ``CREATE DATABASE``.

    The replica that answers the journal probe already has the database (and
    no journal), while the replica the next request reaches does not yet. Here
    the database does not exist on the server at first, so every real request
    fails with UNKNOWN_DATABASE, until the first such failure "propagates" it.
    """

    def __init__(self, target: ClickHouseClient, propagate: Callable[[], None]) -> None:
        self._target = target
        self._propagate = propagate
        self._propagated = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target, name)

    def _lagging(self, run: Callable[[], Any]) -> Any:
        try:
            return run()
        except Exception as error:
            if not self._propagated and is_unknown_database_error(error):
                self._propagated = True
                self._propagate()
            raise

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        self._lagging(lambda: self._target.execute(statement, settings))

    def query(self, statement: str, settings: dict[str, Any] | None = None) -> QueryResult:
        if not self._propagated and statement.startswith(_PROBE_PREFIX):
            msg = "Code: 60. DB::Exception: Table does not exist. (UNKNOWN_TABLE)"
            raise RuntimeError(msg)
        result: QueryResult = self._lagging(lambda: self._target.query(statement, settings))
        return result


@pytest.fixture
def admin() -> Iterator[ClickHouseClient]:
    with _connect(resolve_live_env().clickhouse_database) as client:
        yield client


def test_journal_lands_in_the_target_database_never_in_default(
    admin: ClickHouseClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = f"{create_prefix('lagging_db_py')}db"
    journal_table = create_journal_table_name("lagging_db_py")
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    stray_journal = f"{quote_ident(_SERVER_DEFAULT_DATABASE)}.{quote_ident(journal_table)}"
    target = _connect(database)
    try:
        client = _LaggingReplicaClient(
            target, lambda: admin.execute(f"CREATE DATABASE {quote_ident(database)}")
        )
        store = JournalStore(client)  # type: ignore[arg-type]
        store.write_migration_state(
            MigrationRowState.model_validate(
                {
                    "name": "bootstrap.sql",
                    "appliedAt": "2026-11-10T12:00:00.000",
                    "checksum": "cs",
                    "chkitVersion": "v",
                    "migrationCompleted": True,
                    "operations": [],
                }
            )
        )

        stray = admin.query(
            "SELECT count() AS tables FROM system.tables "
            f"WHERE database = '{_SERVER_DEFAULT_DATABASE}' AND name = '{journal_table}'"
        ).rows
        assert int(stray[0]["tables"]) == 0
        assert store.database_missing is False
        journal = poll_until(
            lambda: admin.query(
                f"SELECT name FROM {quote_ident(database)}.{quote_ident(journal_table)} FINAL "
                "SETTINGS select_sequential_consistency = 1"
            ).rows,
            lambda rows: len(rows) == 1,
        )
        assert journal == [{"name": "bootstrap.sql"}]
    finally:
        target.close()
        admin.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        admin.execute(f"DROP TABLE IF EXISTS {stray_journal} SYNC")
