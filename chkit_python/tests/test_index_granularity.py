"""``clickhouse.indexGranularity``: the server's MergeTree default (#466).

Mirrors ``packages/core/src/model.test.ts`` and
``packages/clickhouse/src/index-granularity.test.ts``.
"""

from __future__ import annotations

from typing import Any

import pytest

from chkit.clickhouse.index_granularity import (
    IndexGranularityMismatchError,
    assert_server_index_granularity,
)
from chkit.core.model import ChxUserConfig, configured_index_granularity, resolve_config


def _resolve(index_granularity: int | None = None) -> Any:
    clickhouse: dict[str, Any] = {"url": "http://localhost:8123"}
    if index_granularity is not None:
        clickhouse["indexGranularity"] = index_granularity
    return resolve_config(ChxUserConfig.model_validate({"schema": "s", "clickhouse": clickhouse}))


def test_defaults_to_8192_the_clickhouse_default() -> None:
    assert _resolve().clickhouse.index_granularity == 8192
    no_clickhouse = resolve_config(ChxUserConfig.model_validate({"schema": "s"}))
    assert configured_index_granularity(no_clickhouse) == 8192


def test_takes_the_server_default_the_config_names() -> None:
    assert configured_index_granularity(_resolve(4096)) == 4096


@pytest.mark.parametrize("value", [0, -1])
def test_rejects_a_value_that_is_not_a_positive_integer(value: int) -> None:
    with pytest.raises(ValueError, match=r"Invalid clickhouse\.indexGranularity"):
        _resolve(value)


class _Rows:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows


class _Client:
    def __init__(self, rows: list[dict[str, Any]] | None = None, error: Exception | None = None):
        self._rows = rows or []
        self._error = error

    def query(self, _sql: str) -> _Rows:
        if self._error is not None:
            raise self._error
        return _Rows(self._rows)


def test_passes_when_the_server_default_is_the_configured_one() -> None:
    assert_server_index_granularity(_Client([{"value": "8192"}]), 8192)


def test_names_the_server_value_and_the_fix_when_they_differ() -> None:
    with pytest.raises(IndexGranularityMismatchError) as raised:
        assert_server_index_granularity(_Client([{"value": "4096"}]), 8192)
    assert str(raised.value) == (
        "This server's MergeTree index_granularity default is 4096, but chkit assumes 8192 "
        "for tables that do not declare index_granularity. Set clickhouse.indexGranularity: "
        "4096 in the config."
    )


def test_checks_nothing_when_the_server_cannot_be_asked() -> None:
    assert_server_index_granularity(_Client(error=RuntimeError("Not enough privileges")), 8192)
    assert_server_index_granularity(_Client([]), 8192)
