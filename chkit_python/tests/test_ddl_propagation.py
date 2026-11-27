"""Tests for `chkit.clickhouse.ddl_propagation`.

Uses a fake client that returns scripted responses on each ``query()`` call
and a fake clock (``propagation_clock``) so the retry loop runs at zero cost.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from clickhouse_connect.driver.exceptions import (  # type: ignore[import-untyped]
    DatabaseError,
    OperationalError,
)

from chkit.clickhouse.ddl_propagation import (
    wait_for_column,
    wait_for_ddl_propagation,
    wait_for_dictionary,
    wait_for_table,
    wait_for_table_absent,
    wait_for_view,
)

if TYPE_CHECKING:
    from tests.conftest import PropagationClock

pytestmark = pytest.mark.usefixtures("single_replica", "propagation_clock")

# Checks before a wait gives up: 0.5 s apart until the 30 s deadline (#719).
CHECKS = 60


class _FakeResult:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows


class _ScriptedClient:
    """Returns a sequence of canned results, one per query() call."""

    def __init__(self, responses: list[list[dict[str, Any]]]) -> None:
        self._responses = list(responses)
        self.queries: list[str] = []

    def query(self, sql: str) -> _FakeResult:
        self.queries.append(sql)
        if not self._responses:
            return _FakeResult([])
        return _FakeResult(self._responses.pop(0))


# ---------- wait_for_table ----------


def test_wait_for_table_returns_when_present() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_table(client, "db", "t")
    assert "db" in client.queries[0]
    assert "t" in client.queries[0]


def test_wait_for_table_retries_until_visible() -> None:
    # First two attempts return empty (not yet visible), third succeeds.
    client = _ScriptedClient([[], [], [{"x": 1}]])
    wait_for_table(client, "db", "t")
    assert len(client.queries) == 3


def test_wait_for_table_raises_after_max_attempts() -> None:
    client = _ScriptedClient([[] for _ in range(CHECKS)])
    with pytest.raises(RuntimeError, match="not yet visible"):
        wait_for_table(client, "db", "ghost")


def test_wait_for_table_escapes_quotes_and_backslashes() -> None:
    # Names are escaped as ClickHouse string literals, matching TS (#231).
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_table(client, "db'name", "t\\'name")
    assert "database = 'db\\'name'" in client.queries[0]
    assert "name = 't\\\\\\'name'" in client.queries[0]


# ---------- wait_for_view ----------


def test_wait_for_view_requires_view_engine_filter() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_view(client, "db", "v")
    assert "engine LIKE '%View%'" in client.queries[0]


def test_wait_for_view_raises_when_never_visible() -> None:
    client = _ScriptedClient([[] for _ in range(CHECKS)])
    with pytest.raises(RuntimeError, match="not yet visible"):
        wait_for_view(client, "db", "v")


# ---------- wait_for_column ----------


def test_wait_for_column_uses_system_columns_query() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_column(client, "db", "t", "c")
    assert "system.columns" in client.queries[0]
    assert "name = 'c'" in client.queries[0]


# ---------- wait_for_table_absent ----------


def test_wait_for_table_absent_returns_when_already_gone() -> None:
    client = _ScriptedClient([[]])
    wait_for_table_absent(client, "db", "t")
    assert len(client.queries) == 1


def test_wait_for_table_absent_retries_until_gone() -> None:
    client = _ScriptedClient([[{"x": 1}], [{"x": 1}], []])
    wait_for_table_absent(client, "db", "t")
    assert len(client.queries) == 3


def test_wait_for_table_absent_raises_when_still_present() -> None:
    client = _ScriptedClient([[{"x": 1}] for _ in range(CHECKS)])
    with pytest.raises(RuntimeError, match="still present"):
        wait_for_table_absent(client, "db", "t")


# ---------- wait_for_ddl_propagation dispatcher ----------


def test_wait_for_dictionary_reads_the_catalog_not_the_loader() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_dictionary(client, "db", "users_dict")
    assert "system.tables" in client.queries[0]
    assert "engine = 'Dictionary'" in client.queries[0]
    assert "name = 'users_dict'" in client.queries[0]
    assert "system.dictionaries" not in client.queries[0]


def test_dispatch_create_table_calls_wait_for_table() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_ddl_propagation(client, "create_table", "table:db.events")
    assert "system.tables" in client.queries[0]
    assert "name = 'events'" in client.queries[0]


def test_dispatch_create_view_calls_wait_for_view() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_ddl_propagation(client, "create_view", "table:db.v")
    assert "engine LIKE '%View%'" in client.queries[0]


def test_dispatch_create_materialized_view_calls_wait_for_view() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_ddl_propagation(
        client, "create_materialized_view", "table:db.mv"
    )
    assert "engine LIKE '%View%'" in client.queries[0]


def test_dispatch_alter_add_column_calls_wait_for_column() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_ddl_propagation(
        client, "alter_table_add_column", "table:db.t:column:newcol"
    )
    assert "system.columns" in client.queries[0]
    assert "name = 'newcol'" in client.queries[0]


def test_dispatch_alter_add_column_without_column_segment_skips() -> None:
    client = _ScriptedClient([])
    wait_for_ddl_propagation(client, "alter_table_add_column", "table:db.t")
    assert client.queries == []


def test_dispatch_drop_table_calls_wait_for_table_absent() -> None:
    client = _ScriptedClient([[]])
    wait_for_ddl_propagation(client, "drop_table", "table:db.t")
    assert "system.tables" in client.queries[0]


def test_dispatch_unknown_operation_falls_back_to_wait_for_table() -> None:
    client = _ScriptedClient([[{"x": 1}]])
    wait_for_ddl_propagation(
        client, "alter_table_modify_setting", "table:db.t"
    )
    assert "system.tables" in client.queries[0]


def test_dispatch_database_level_op_returns_immediately() -> None:
    client = _ScriptedClient([])
    wait_for_ddl_propagation(client, "create_database", "database:foo")
    assert client.queries == []


def test_dispatch_malformed_key_returns_immediately() -> None:
    client = _ScriptedClient([])
    wait_for_ddl_propagation(client, "create_table", "weird-key")
    assert client.queries == []


# ---------- retry budget (#578, #719) ----------
# Checks 0.5 s apart until a 30 s deadline, no delay after the last: 60 checks.
# ddl-propagation.test.ts pins the same.


def test_table_that_never_appears_is_checked_60_times(propagation_clock: PropagationClock) -> None:
    client = _ScriptedClient([[] for _ in range(100)])
    with pytest.raises(RuntimeError, match=r"waitForTable: db\.events not yet visible"):
        wait_for_ddl_propagation(client, "create_table", "table:db.events")
    assert len(client.queries) == CHECKS
    assert propagation_clock.sleeps == [0.5] * (CHECKS - 1)


def test_table_that_appears_after_15_seconds_passes(propagation_clock: PropagationClock) -> None:
    client = _ScriptedClient([*([] for _ in range(30)), [{"x": 1}]])
    wait_for_ddl_propagation(client, "create_table", "table:db.events")
    assert len(client.queries) == 31
    assert propagation_clock.now == 15.0


def test_table_that_appears_on_the_60th_check_passes(propagation_clock: PropagationClock) -> None:
    client = _ScriptedClient([*([] for _ in range(CHECKS - 1)), [{"x": 1}]])
    wait_for_ddl_propagation(client, "create_table", "table:db.events")
    assert len(client.queries) == CHECKS
    assert propagation_clock.sleeps == [0.5] * (CHECKS - 1)


def test_dropped_table_listed_for_20_seconds_passes(propagation_clock: PropagationClock) -> None:
    client = _ScriptedClient([*([{"x": 1}] for _ in range(40)), []])
    wait_for_ddl_propagation(client, "drop_table", "table:db.events__cutover_1_reconcile")
    assert len(client.queries) == 41
    assert propagation_clock.now == 20.0


def test_dropped_table_still_listed_fails_after_30_seconds(propagation_clock: PropagationClock) -> None:
    client = _ScriptedClient([[{"x": 1}] for _ in range(100)])
    with pytest.raises(
        RuntimeError, match=r"waitForTableAbsent: db\.events__cutover_1_reconcile still present"
    ):
        wait_for_ddl_propagation(client, "drop_table", "table:db.events__cutover_1_reconcile")
    assert len(client.queries) == CHECKS
    assert propagation_clock.now == 29.5


class _FailingClient:
    """Raises ``error`` from every catalog query; counts the checks."""

    def __init__(self, error: Exception) -> None:
        self.error = error
        self.checks = 0

    def query(self, sql: str) -> _FakeResult:
        self.checks += 1
        raise self.error


# p-retry gives up at once on a TypeError that is not a fetch network failure:
# a bug in the check, not lag. TypeError and AttributeError are the Python
# equivalents. ddl-propagation.test.ts pins the same (#627).


@pytest.mark.parametrize(
    "error",
    [
        TypeError("'NoneType' object is not subscriptable"),
        AttributeError("'NoneType' object has no attribute 'rows'"),
    ],
    ids=["TypeError", "AttributeError"],
)
def test_a_programming_error_in_the_check_fails_after_one_check(
    propagation_clock: PropagationClock, error: Exception
) -> None:
    client = _FailingClient(error)
    with pytest.raises(type(error), match=str(error)):
        wait_for_ddl_propagation(client, "create_table", "table:db.events")
    assert client.checks == 1
    assert propagation_clock.sleeps == []


@pytest.mark.parametrize(
    "error",
    [
        DatabaseError("Code: 60. DB::Exception: Unknown table"),
        OperationalError("Error HTTPConnectionPool: Connection refused"),
    ],
    ids=["server", "network"],
)
def test_a_server_or_network_error_in_the_check_is_retried_for_30_seconds(
    propagation_clock: PropagationClock, error: Exception
) -> None:
    client = _FailingClient(error)
    with pytest.raises(type(error)):
        wait_for_ddl_propagation(client, "create_table", "table:db.events")
    assert client.checks == CHECKS
    assert propagation_clock.sleeps == [0.5] * (CHECKS - 1)


def test_dictionary_that_never_appears_is_checked_60_times(
    propagation_clock: PropagationClock,
) -> None:
    client = _ScriptedClient([])
    with pytest.raises(RuntimeError, match=r"waitForDictionary: db\.users not yet visible"):
        wait_for_ddl_propagation(client, "create_dictionary", "dictionary:db.users")
    assert len(client.queries) == CHECKS
    assert propagation_clock.sleeps == [0.5] * (CHECKS - 1)


def test_dictionary_that_appears_after_15_seconds_passes(propagation_clock: PropagationClock) -> None:
    client = _ScriptedClient([*([] for _ in range(30)), [{"x": 1}]])
    wait_for_ddl_propagation(client, "create_dictionary", "dictionary:db.users")
    assert len(client.queries) == 31
    assert propagation_clock.now == 15.0
