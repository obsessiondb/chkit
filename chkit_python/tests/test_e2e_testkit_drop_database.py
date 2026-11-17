"""Unit tests for ``drop_database`` in :mod:`tests.e2e_testkit` (#725).

Port of ``packages/clickhouse/src/e2e-testkit-drop-database.test.ts``.
"""

from __future__ import annotations

import pytest

from tests.e2e_testkit import drop_database

# The error clickhouse-connect raises when a table reached the serving replica
# while DROP DATABASE ran.
_DATABASE_NOT_EMPTY = (
    "Received ClickHouse exception, code: 219, server response: Code: 219. "
    "DB::Exception: New table appeared in database being dropped or detached. "
    "Try again. (DATABASE_NOT_EMPTY)"
)


class _FakeClient:
    def __init__(self, failures: list[Exception]) -> None:
        self.failures = failures
        self.statements: list[str] = []

    def execute(self, sql: str) -> None:
        self.statements.append(sql)
        if self.failures:
            raise self.failures.pop(0)


def test_drop_database_reruns_the_drop_while_it_fails_with_database_not_empty() -> None:
    client = _FakeClient([RuntimeError(_DATABASE_NOT_EMPTY), RuntimeError(_DATABASE_NOT_EMPTY)])
    drop_database(client, "a`b", interval=0.001)
    assert client.statements == ["DROP DATABASE IF EXISTS `a\\`b` SYNC"] * 3


def test_drop_database_raises_any_other_error_at_once() -> None:
    client = _FakeClient([RuntimeError("Code: 497. (ACCESS_DENIED)")])
    with pytest.raises(RuntimeError, match="ACCESS_DENIED"):
        drop_database(client, "db", interval=0.001)
    assert len(client.statements) == 1


def test_drop_database_raises_database_not_empty_once_the_timeout_passes() -> None:
    client = _FakeClient([RuntimeError(_DATABASE_NOT_EMPTY) for _ in range(1000)])
    with pytest.raises(RuntimeError, match="Try again"):
        drop_database(client, "db", timeout=0.02, interval=0.005)
