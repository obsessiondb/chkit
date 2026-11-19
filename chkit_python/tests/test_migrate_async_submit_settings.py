"""#812: an async statement is journaled complete at its QueryFinish, so a
statement that can queue work is sent with settings that make it wait.

Port of ``packages/cli/src/test/commands/migrate/async-submit-settings.test.ts``.
"""

from __future__ import annotations

import pytest

from chkit.cli.commands.migrate_async_apply import async_submit_settings

_WAITS = {
    "mutations_sync": "2",
    "lightweight_deletes_sync": "2",
    "alter_sync": "2",
    "distributed_ddl_task_timeout": "-1",
    "distributed_ddl_output_mode": "throw",
}


@pytest.mark.parametrize(
    "sql",
    [
        "ALTER TABLE t UPDATE v = 1 WHERE 1",
        "ALTER TABLE t ON CLUSTER c DELETE WHERE k = 1",
        "ALTER TABLE t ON CLUSTER c ADD COLUMN x UInt8",
        "OPTIMIZE TABLE t FINAL",
        "DELETE FROM t WHERE k = 1",
    ],
)
def test_waits_for_the_work_over_the_setting_values(sql: str) -> None:
    settings = {
        "mutations_sync": "0",
        "lightweight_deletes_sync": "0",
        "alter_sync": "0",
        "max_threads": "4",
    }
    assert async_submit_settings(sql, settings) == {**_WAITS, "max_threads": "4"}
    assert async_submit_settings(sql, None) == _WAITS


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO t SELECT 1",
        "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
        "SELECT 1",
    ],
)
def test_sends_a_select_or_an_insert_with_the_setting_values_alone(sql: str) -> None:
    settings = {"max_threads": "4"}
    assert async_submit_settings(sql, settings) is settings
    assert async_submit_settings(sql, None) is None
