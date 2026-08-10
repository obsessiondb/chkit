"""Poll ClickHouse system tables until DDL changes are visible.

1:1 port of ``packages/clickhouse/src/ddl-propagation.ts``.

ClickHouse DDL is *eventually consistent* on ReplicatedMergeTree and on
ObsessionDB's Shared engines: a successful ``CREATE TABLE`` returns
before every replica has the new schema. Migrations that follow up with
``ALTER`` / ``INSERT`` on the freshly-created object would race and
fail. These helpers poll ``system.tables`` / ``system.columns`` until
the operation is observable, then return.

Retry strategy: 20 attempts x 500 ms delay (~10 s budget). Matches the TS
``p-retry`` defaults (``factor: 1`` -> fixed delay, no exponential backoff).

The polling client is passed in (any object with a ``query(sql) ->
QueryResult`` method) so this module can be unit-tested without a live
database.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

MAX_ATTEMPTS = 20
RETRY_DELAY_SECONDS = 0.5


def _quote(value: str) -> str:
    """Escape single quotes for embedding in a SQL string literal."""
    return value.replace("'", "''")


def _poll(
    check_fn: Callable[[], bool],
    *,
    attempts: int = MAX_ATTEMPTS,
    delay: float = RETRY_DELAY_SECONDS,
) -> None:
    """Call ``check_fn`` until it returns truthy or ``attempts`` is exhausted.

    Raises the last error from ``check_fn`` if every attempt fails.
    """
    last_error: BaseException | None = None
    for _ in range(attempts):
        try:
            if check_fn():
                return
        except Exception as error:
            last_error = error
        time.sleep(delay)
    if last_error is not None:
        raise last_error
    msg = "polling exhausted without success or error"
    raise RuntimeError(msg)


def wait_for_table(client: Any, database: str, table_name: str) -> None:
    """Poll ``system.tables`` until ``database.table_name`` appears."""
    sql = (
        f"SELECT 1 AS x FROM system.tables "
        f"WHERE database = '{_quote(database)}' AND name = '{_quote(table_name)}'"
    )

    def _check() -> bool:
        result = client.query(sql)
        if len(result.rows) == 0:
            msg = f"wait_for_table: {database}.{table_name} not yet visible"
            raise RuntimeError(msg)
        return True

    _poll(_check)


def wait_for_view(client: Any, database: str, view_name: str) -> None:
    """Poll ``system.tables`` until ``database.view_name`` appears as a view."""
    sql = (
        f"SELECT 1 AS x FROM system.tables "
        f"WHERE database = '{_quote(database)}' AND name = '{_quote(view_name)}' "
        f"AND engine LIKE '%View%'"
    )

    def _check() -> bool:
        result = client.query(sql)
        if len(result.rows) == 0:
            msg = f"wait_for_view: {database}.{view_name} not yet visible"
            raise RuntimeError(msg)
        return True

    _poll(_check)


def wait_for_dictionary(client: Any, database: str, dictionary_name: str) -> None:
    """Poll ``system.dictionaries`` until ``database.dictionary_name`` appears."""
    sql = (
        f"SELECT 1 AS x FROM system.dictionaries "
        f"WHERE database = '{_quote(database)}' AND name = '{_quote(dictionary_name)}'"
    )

    def _check() -> bool:
        result = client.query(sql)
        if len(result.rows) == 0:
            msg = f"wait_for_dictionary: {database}.{dictionary_name} not yet visible"
            raise RuntimeError(msg)
        return True

    _poll(_check)


def wait_for_column(
    client: Any, database: str, table_name: str, column_name: str
) -> None:
    """Poll ``system.columns`` until the column appears under the table."""
    sql = (
        f"SELECT 1 AS x FROM system.columns "
        f"WHERE database = '{_quote(database)}' "
        f"AND table = '{_quote(table_name)}' "
        f"AND name = '{_quote(column_name)}'"
    )

    def _check() -> bool:
        result = client.query(sql)
        if len(result.rows) == 0:
            msg = (
                f"wait_for_column: {database}.{table_name}.{column_name} "
                f"not yet visible"
            )
            raise RuntimeError(msg)
        return True

    _poll(_check)


def wait_for_table_absent(client: Any, database: str, table_name: str) -> None:
    """Poll ``system.tables`` until ``database.table_name`` no longer appears."""
    sql = (
        f"SELECT 1 AS x FROM system.tables "
        f"WHERE database = '{_quote(database)}' AND name = '{_quote(table_name)}'"
    )

    def _check() -> bool:
        result = client.query(sql)
        if len(result.rows) > 0:
            msg = f"wait_for_table_absent: {database}.{table_name} still present"
            raise RuntimeError(msg)
        return True

    _poll(_check)


def wait_for_column_absent(
    client: Any, database: str, table_name: str, column_name: str
) -> None:
    """Poll ``system.columns`` until the column is gone from the table."""
    sql = (
        f"SELECT 1 AS x FROM system.columns "
        f"WHERE database = '{_quote(database)}' "
        f"AND table = '{_quote(table_name)}' "
        f"AND name = '{_quote(column_name)}'"
    )

    def _check() -> bool:
        result = client.query(sql)
        if len(result.rows) > 0:
            msg = (
                f"wait_for_column_absent: {database}.{table_name}.{column_name} "
                f"still present"
            )
            raise RuntimeError(msg)
        return True

    _poll(_check)


def wait_for_index(
    client: Any, database: str, table_name: str, index_name: str
) -> None:
    """Poll ``system.data_skipping_indices`` until the index appears."""
    sql = (
        f"SELECT 1 AS x FROM system.data_skipping_indices "
        f"WHERE database = '{_quote(database)}' "
        f"AND table = '{_quote(table_name)}' "
        f"AND name = '{_quote(index_name)}'"
    )

    def _check() -> bool:
        result = client.query(sql)
        if len(result.rows) == 0:
            msg = (
                f"wait_for_index: {database}.{table_name}.{index_name} "
                f"not yet visible"
            )
            raise RuntimeError(msg)
        return True

    _poll(_check)


def wait_for_index_absent(
    client: Any, database: str, table_name: str, index_name: str
) -> None:
    """Poll ``system.data_skipping_indices`` until the index is gone."""
    sql = (
        f"SELECT 1 AS x FROM system.data_skipping_indices "
        f"WHERE database = '{_quote(database)}' "
        f"AND table = '{_quote(table_name)}' "
        f"AND name = '{_quote(index_name)}'"
    )

    def _check() -> bool:
        result = client.query(sql)
        if len(result.rows) > 0:
            msg = (
                f"wait_for_index_absent: {database}.{table_name}.{index_name} "
                f"still present"
            )
            raise RuntimeError(msg)
        return True

    _poll(_check)


def wait_for_projection(
    client: Any, database: str, table_name: str, projection_name: str
) -> None:
    """Poll ``system.projections`` until the projection appears."""
    sql = (
        f"SELECT 1 AS x FROM system.projections "
        f"WHERE database = '{_quote(database)}' "
        f"AND table = '{_quote(table_name)}' "
        f"AND name = '{_quote(projection_name)}'"
    )

    def _check() -> bool:
        result = client.query(sql)
        if len(result.rows) == 0:
            msg = (
                f"wait_for_projection: {database}.{table_name}.{projection_name} "
                f"not yet visible"
            )
            raise RuntimeError(msg)
        return True

    _poll(_check)


def wait_for_projection_absent(
    client: Any, database: str, table_name: str, projection_name: str
) -> None:
    """Poll ``system.projections`` until the projection is gone."""
    sql = (
        f"SELECT 1 AS x FROM system.projections "
        f"WHERE database = '{_quote(database)}' "
        f"AND table = '{_quote(table_name)}' "
        f"AND name = '{_quote(projection_name)}'"
    )

    def _check() -> bool:
        result = client.query(sql)
        if len(result.rows) > 0:
            msg = (
                f"wait_for_projection_absent: "
                f"{database}.{table_name}.{projection_name} still present"
            )
            raise RuntimeError(msg)
        return True

    _poll(_check)


def _parse_operation_key(
    key: str,
) -> tuple[str, str, str | None, str | None, str | None] | None:
    """Parse an operation key into (database, table, column, index, projection).

    Supported shapes:
        - ``table:db.t``
        - ``table:db.t:column:c``
        - ``table:db.t:index:i``
        - ``table:db.t:projection:p``
        - ``dictionary:db.d``
    """
    if key.startswith("table:"):
        rest = key[len("table:") :]
    elif key.startswith("dictionary:"):
        rest = key[len("dictionary:") :]
    else:
        return None
    dot = rest.find(".")
    if dot == -1:
        return None
    database = rest[:dot]
    after_db = rest[dot + 1 :]
    colon = after_db.find(":")
    table = after_db if colon == -1 else after_db[:colon]
    column: str | None = None
    index: str | None = None
    projection: str | None = None
    if colon != -1:
        suffix = after_db[colon + 1 :]
        kinds = (
            ("column:", "column"),
            ("index:", "index"),
            ("projection:", "projection"),
        )
        for prefix, setter in kinds:
            if suffix.startswith(prefix):
                rest_after = suffix[len(prefix) :]
                next_colon = rest_after.find(":")
                value = rest_after if next_colon == -1 else rest_after[:next_colon]
                if setter == "column":
                    column = value
                elif setter == "index":
                    index = value
                else:
                    projection = value
                break
    return database, table, column, index, projection


def wait_for_ddl_propagation(  # noqa: PLR0911, PLR0912
    client: Any, operation_type: str, operation_key: str
) -> None:
    """Dispatch the right ``wait_for_*`` based on the operation type + key.

    Operation-type → wait predicate map (mirrors TS ddl-propagation.ts):

    - create_table / alter_rename_table              → wait_for_table
    - create_view / create_materialized_view         → wait_for_view
    - create_dictionary                               → wait_for_dictionary
    - drop_dictionary                                 → wait_for_table_absent
    - alter_table_add_column / alter_table_modify_column → wait_for_column
    - alter_table_drop_column                         → wait_for_column_absent
    - drop_table / drop_view / drop_materialized_view → wait_for_table_absent
    - alter_table_add_index                           → wait_for_index
    - alter_table_drop_index                          → wait_for_index_absent
    - alter_table_add_projection                      → wait_for_projection
    - alter_table_drop_projection                     → wait_for_projection_absent
    - everything else (modify_setting, modify_ttl …) → wait_for_table (best-effort)
    """
    parsed = _parse_operation_key(operation_key)
    if parsed is None:
        # database-level ops or unrecognised keys — nothing to poll for.
        return
    database, table, column, index, projection = parsed

    if operation_type in {"create_table", "alter_rename_table"}:
        wait_for_table(client, database, table)
        return
    if operation_type in {"create_view", "create_materialized_view"}:
        wait_for_view(client, database, table)
        return
    if operation_type == "create_dictionary":
        wait_for_dictionary(client, database, table)
        return
    if operation_type in {"alter_table_add_column", "alter_table_modify_column"}:
        if column is not None:
            wait_for_column(client, database, table, column)
        return
    if operation_type == "alter_table_drop_column":
        if column is not None:
            wait_for_column_absent(client, database, table, column)
        return
    if operation_type in {
        "drop_table",
        "drop_view",
        "drop_materialized_view",
        "drop_dictionary",
    }:
        wait_for_table_absent(client, database, table)
        return
    if operation_type == "alter_table_add_index" and index is not None:
        wait_for_index(client, database, table, index)
        return
    if operation_type == "alter_table_drop_index" and index is not None:
        wait_for_index_absent(client, database, table, index)
        return
    if operation_type == "alter_table_add_projection" and projection is not None:
        wait_for_projection(client, database, table, projection)
        return
    if operation_type == "alter_table_drop_projection" and projection is not None:
        wait_for_projection_absent(client, database, table, projection)
        return

    # alter_table_modify_setting, alter_table_modify_ttl, alter_table_reset_setting,
    # alter_materialized_view_modify_refresh, etc. → basic table presence check.
    wait_for_table(client, database, table)
