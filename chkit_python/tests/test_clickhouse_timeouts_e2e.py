"""chkit-py waits for a ClickHouse request as long as TS does (#661).

TS's ``@chkit/clickhouse`` client has no request timeout and asks for a
progress header every 30 s, so a long query stays alive through a proxy with an
idle timeout. clickhouse-connect would cut a silent response after its read
timeout (300 s by default) and ask for progress headers every 120 s.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import clickhouse_connect  # type: ignore[import-untyped]
import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import resolve_live_env

# Shorter than the queries below: without chkit's override, the driver cuts them.
_SHORT_READ_TIMEOUT_SECONDS = 2


def _config() -> ChxResolvedClickHouseConfig:
    env = resolve_live_env()
    return ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https:"),
    )


@pytest.fixture
def short_default_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[ClickHouseClient]:
    """A client whose driver defaults to a 2 s read timeout, standing in for
    clickhouse-connect's 300 s default."""
    open_driver = clickhouse_connect.get_client

    def get_client(**kwargs: Any) -> Any:
        return open_driver(**{"send_receive_timeout": _SHORT_READ_TIMEOUT_SECONDS, **kwargs})

    monkeypatch.setattr(clickhouse_connect, "get_client", get_client)
    with ClickHouseClient.connect(_config()) as client:
        yield client


def test_a_query_outlasts_the_drivers_read_timeout(
    short_default_client: ClickHouseClient,
) -> None:
    result = short_default_client.query("SELECT sleep(3) AS slept")
    assert result.rows == [{"slept": 0}]


def test_a_statement_outlasts_the_drivers_read_timeout(
    short_default_client: ClickHouseClient,
) -> None:
    short_default_client.execute("SELECT sleep(3) FORMAT Null")


def test_a_submitted_statement_outlasts_the_drivers_read_timeout(
    short_default_client: ClickHouseClient,
) -> None:
    # submit sends through its own session-less driver (#603).
    query_id = str(uuid.uuid4())
    assert short_default_client.submit("SELECT sleep(3) FORMAT Null", query_id) == query_id


def test_queries_ask_for_a_progress_header_every_30_seconds_as_ts() -> None:
    with ClickHouseClient.connect(_config()) as client:
        result = client.query(
            "SELECT getSetting('send_progress_in_http_headers') AS send, "
            "getSetting('http_headers_progress_interval_ms') AS interval_ms"
        )
    assert result.rows == [{"send": True, "interval_ms": 30000}]


def test_a_setting_passed_with_the_query_still_wins() -> None:
    with ClickHouseClient.connect(_config()) as client:
        result = client.query(
            "SELECT getSetting('http_headers_progress_interval_ms') AS interval_ms",
            settings={"http_headers_progress_interval_ms": 5000},
        )
    assert result.rows == [{"interval_ms": 5000}]
