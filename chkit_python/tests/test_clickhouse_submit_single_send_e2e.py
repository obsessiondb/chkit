"""chkit-py sends an async submit once (#767).

The submit's query id is journaled for that attempt alone. clickhouse-connect
sends a request again when the server reset the connection, even with
``query_retries=0``, so a submit whose INSERT committed before the reset could
run again under the same id. The submit driver must not replay it, as TS's
client does not.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from urllib3.exceptions import ProtocolError

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import resolve_live_env


def _config() -> ChxResolvedClickHouseConfig:
    env = resolve_live_env()
    return ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https:"),
    )


class _ResetAfterSendPool:
    """Sends nothing; answers each request as a server that committed it and
    then reset the connection."""

    def __init__(self, pool: Any) -> None:
        self._pool = pool
        self.requests: list[dict[str, Any]] = []

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pool, name)

    def request(self, *_args: Any, **kwargs: Any) -> Any:
        self.requests.append(kwargs)
        try:
            raise ConnectionResetError("Connection reset by peer")
        except ConnectionResetError as reset:
            raise ProtocolError("Connection aborted.", reset) from reset


def test_a_submit_whose_connection_resets_is_sent_once() -> None:
    with ClickHouseClient.connect(_config()) as client:
        driver = client._submit_driver()
        # The HTTP pool under whatever wrapper the submit driver has.
        holder = driver.http if hasattr(driver.http, "_pool") else driver
        attribute = "_pool" if holder is driver.http else "http"
        pool = _ResetAfterSendPool(getattr(holder, attribute))
        setattr(holder, attribute, pool)
        with pytest.raises(ConnectionError, match="reset after the request was sent"):
            client.submit("SELECT 1", query_id=str(uuid.uuid4()))
    assert len(pool.requests) == 1
    assert pool.requests[0]["retries"] is False
