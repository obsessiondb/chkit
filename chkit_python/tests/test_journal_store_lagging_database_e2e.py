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

    The replica that answers the reads already has the database (and no
    journal), while the replica the journal ``CREATE`` reaches does not yet.
    Here the database does not exist on the server at first, so the real
    ``CREATE`` fails with UNKNOWN_DATABASE and goes through the client's retry
    without the database; only then does the database "propagate".
    """

    def __init__(
        self, target: ClickHouseClient, database: str, propagate: Callable[[], None]
    ) -> None:
        self._target = target
        self._database = database
        self._propagate = propagate
        self._propagated = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target, name)

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        try:
            self._target.execute(statement, settings)
        except Exception as error:
            if not self._propagated and is_unknown_database_error(error):
                self._propagated = True
                self._propagate()
            raise

    def query(self, statement: str, settings: dict[str, Any] | None = None) -> QueryResult:
        if not self._propagated:
            if statement.startswith("SELECT currentDatabase()"):
                return QueryResult(column_names=["database"], rows=[{"database": self._database}])
            if statement.startswith(_PROBE_PREFIX):
                msg = "Code: 60. DB::Exception: Table does not exist. (UNKNOWN_TABLE)"
                raise RuntimeError(msg)
        return self._target.query(statement, settings)


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
            target, database, lambda: admin.execute(f"CREATE DATABASE {quote_ident(database)}")
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


class _InsertsThroughLaggingReplica:
    """Sends journal INSERTs to ``lagging``, a replica that has not applied
    ``CREATE DATABASE`` yet: they fail with UNKNOWN_DATABASE, and the client
    retries them without the database (#700)."""

    def __init__(self, target: ClickHouseClient, lagging: ClickHouseClient) -> None:
        self._target = target
        self._lagging = lagging

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target, name)

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        client = self._lagging if statement.startswith("INSERT INTO") else self._target
        client.execute(statement, settings)


def _row_state(name: str) -> MigrationRowState:
    return MigrationRowState.model_validate(
        {
            "name": name,
            "appliedAt": "2026-11-10T12:00:00.000",
            "checksum": "cs",
            "chkitVersion": "v",
            "migrationCompleted": True,
            "operations": [],
        }
    )


def test_a_journal_insert_on_a_replica_without_the_database_never_lands_in_default(
    admin: ClickHouseClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = f"{create_prefix('lagging_insert_py')}db"
    journal_table = create_journal_table_name("lagging_insert_py")
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    journal = f"{quote_ident(database)}.{quote_ident(journal_table)}"
    stray_journal = f"{quote_ident(_SERVER_DEFAULT_DATABASE)}.{quote_ident(journal_table)}"
    admin.execute(f"CREATE DATABASE {quote_ident(database)}")
    target = _connect(database)
    lagging = _connect(f"{database}_lagging")
    try:
        JournalStore(target).write_migration_state(_row_state("first.sql"))
        # A compatible journal in default, as another project or #493 left one.
        admin.execute(f"CREATE TABLE {stray_journal} AS {journal}")

        store = JournalStore(_InsertsThroughLaggingReplica(target, lagging))  # type: ignore[arg-type]
        store.write_migration_state(_row_state("second.sql"))

        stray = admin.query(f"SELECT count() AS rows FROM {stray_journal}").rows
        assert int(stray[0]["rows"]) == 0
        rows = poll_until(
            lambda: admin.query(
                f"SELECT name FROM {journal} FINAL ORDER BY name "
                "SETTINGS select_sequential_consistency = 1"
            ).rows,
            lambda found: len(found) == 2,
        )
        assert rows == [{"name": "first.sql"}, {"name": "second.sql"}]
    finally:
        lagging.close()
        target.close()
        admin.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        admin.execute(f"DROP TABLE IF EXISTS {stray_journal} SYNC")
