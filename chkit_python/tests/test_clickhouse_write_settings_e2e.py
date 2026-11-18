"""A write is stored when it returns, also under a fire-and-forget profile (#767).

TS sends ``async_insert = 0`` with every command
(``packages/clickhouse/src/write-settings.e2e.test.ts``), so a statement chkit
journals as completed is not left in an asynchronous-insert buffer. chkit-py
sends the same setting.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import create_prefix, quote_ident, resolve_live_env

# ObsessionDB users have no CREATE USER (or any access-management) grant
# (#430), so this test runs in verify, against the local stack, only.
_ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"


def _config(username: str, password: str) -> ChxResolvedClickHouseConfig:
    env = resolve_live_env()
    return ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=username,
        password=password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https:"),
    )


@pytest.fixture
def admin() -> Iterator[ClickHouseClient]:
    env = resolve_live_env()
    with ClickHouseClient.connect(_config(env.clickhouse_user, env.clickhouse_password)) as client:
        yield client


@pytest.mark.skipif(_ON_OBSESSIONDB, reason="ObsessionDB users have no CREATE USER grant (#430)")
def test_a_statement_is_no_asynchronous_insert_under_a_fire_and_forget_profile(
    admin: ClickHouseClient,
) -> None:
    env = resolve_live_env()
    prefix = create_prefix("write_settings_py")
    user = f"{prefix}user"
    password = "Pw-767-write-settings"
    table = f"{quote_ident(env.clickhouse_database)}.{quote_ident(f'{prefix}t')}"
    try:
        admin.execute(f"CREATE TABLE {table} (id UInt64) ENGINE = MergeTree ORDER BY id")
        admin.execute(
            f"CREATE USER {quote_ident(user)} IDENTIFIED BY '{password}' SETTINGS "
            "async_insert = 1, wait_for_async_insert = 0, "
            "async_insert_use_adaptive_busy_timeout = 0, async_insert_busy_timeout_max_ms = 30000"
        )
        admin.execute(f"GRANT SELECT, INSERT ON {table} TO {quote_ident(user)}")
        with ClickHouseClient.connect(_config(user, password)) as client:
            client.execute(f"INSERT INTO {table} VALUES (1)")
            # Stored when the statement returned: a buffered insert would
            # wait out the profile's 30 s flush timeout.
            rows = client.query(f"SELECT toString(count()) AS n FROM {table}").rows
        assert rows == [{"n": "1"}]
    finally:
        admin.execute(f"DROP USER IF EXISTS {quote_ident(user)}")
        admin.execute(f"DROP TABLE IF EXISTS {table} SYNC")
