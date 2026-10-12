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
from typing import Any, Literal

from chkit.clickhouse.replicas import ReplicaFanout, all_replicas, resolve_replica_fanout

MAX_ATTEMPTS = 20
RETRY_DELAY_SECONDS = 0.5


# What each ALTER or rename appends to the `<kind>:<database>.<name>` key of
# the object it changes. Creates and drops use the bare key.
_KEY_SUFFIXES: dict[str, str] = {
    "alter_materialized_view_modify_refresh": ":refresh",
    "alter_table_add_column": ":column:",
    "alter_table_modify_column": ":column:",
    "alter_table_drop_column": ":column:",
    "alter_table_rename_column": ":column_rename:",
    "alter_table_add_index": ":index:",
    "alter_table_drop_index": ":index:",
    "alter_table_add_projection": ":projection:",
    "alter_table_drop_projection": ":projection:",
    "alter_table_modify_setting": ":setting:",
    "alter_table_reset_setting": ":setting:",
    "alter_table_modify_ttl": ":ttl",
    "alter_table_rename_table": ":rename_table",
    "rename_dictionary": ":rename_dictionary",
}
_OBJECT_KEY_PREFIXES = ("table:", "dictionary:", "view:", "materialized_view:")


def _quote(value: str) -> str:
    """Escape a value for embedding in a single-quoted SQL string literal.

    Object names may contain quotes and backslashes (DDL backtick-quotes them),
    so the names compared against system tables are escaped string literals.
    """
    return value.replace("\\", "\\\\").replace("'", "\\'")


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


def wait_for_table(
    client: Any, database: str, table_name: str, *, cluster: str | None = None
) -> None:
    """Poll ``system.tables`` until ``database.table_name`` appears."""
    _wait_for_system_rows(
        client,
        source="system.tables",
        where=f"database = '{_quote(database)}' AND name = '{_quote(table_name)}'",
        want="present",
        label=f"wait_for_table: {database}.{table_name} not yet visible",
        cluster=cluster,
    )

def wait_for_view(
    client: Any, database: str, view_name: str, *, cluster: str | None = None
) -> None:
    """Poll ``system.tables`` until ``database.view_name`` appears as a view."""
    _wait_for_system_rows(
        client,
        source="system.tables",
        where=(
            f"database = '{_quote(database)}' AND name = '{_quote(view_name)}' "
            "AND engine LIKE '%View%'"
        ),
        want="present",
        label=f"wait_for_view: {database}.{view_name} not yet visible",
        cluster=cluster,
    )

def wait_for_dictionary(
    client: Any, database: str, dictionary_name: str, *, cluster: str | None = None
) -> None:
    """Poll ``system.dictionaries`` until ``database.dictionary_name`` appears."""
    _wait_for_system_rows(
        client,
        source="system.dictionaries",
        where=f"database = '{_quote(database)}' AND name = '{_quote(dictionary_name)}'",
        want="present",
        label=f"wait_for_dictionary: {database}.{dictionary_name} not yet visible",
        cluster=cluster,
    )

def wait_for_column(
    client: Any,
    database: str,
    table_name: str,
    column_name: str,
    *,
    cluster: str | None = None,
) -> None:
    """Poll ``system.columns`` until the column appears under the table."""
    _wait_for_system_rows(
        client,
        source="system.columns",
        where=(
            f"database = '{_quote(database)}' "
            f"AND table = '{_quote(table_name)}' "
            f"AND name = '{_quote(column_name)}'"
        ),
        want="present",
        label=f"wait_for_column: {database}.{table_name}.{column_name} not yet visible",
        cluster=cluster,
    )

def wait_for_table_absent(
    client: Any, database: str, table_name: str, *, cluster: str | None = None
) -> None:
    """Poll ``system.tables`` until ``database.table_name`` no longer appears."""
    _wait_for_system_rows(
        client,
        source="system.tables",
        where=f"database = '{_quote(database)}' AND name = '{_quote(table_name)}'",
        want="absent",
        label=f"wait_for_table_absent: {database}.{table_name} still present",
        cluster=cluster,
    )

def wait_for_column_absent(
    client: Any,
    database: str,
    table_name: str,
    column_name: str,
    *,
    cluster: str | None = None,
) -> None:
    """Poll ``system.columns`` until the column is gone from the table."""
    _wait_for_system_rows(
        client,
        source="system.columns",
        where=(
            f"database = '{_quote(database)}' "
            f"AND table = '{_quote(table_name)}' "
            f"AND name = '{_quote(column_name)}'"
        ),
        want="absent",
        label=f"wait_for_column_absent: {database}.{table_name}.{column_name} still present",
        cluster=cluster,
    )

def wait_for_index(
    client: Any,
    database: str,
    table_name: str,
    index_name: str,
    *,
    cluster: str | None = None,
) -> None:
    """Poll ``system.data_skipping_indices`` until the index appears."""
    _wait_for_system_rows(
        client,
        source="system.data_skipping_indices",
        where=(
            f"database = '{_quote(database)}' "
            f"AND table = '{_quote(table_name)}' "
            f"AND name = '{_quote(index_name)}'"
        ),
        want="present",
        label=f"wait_for_index: {database}.{table_name}.{index_name} not yet visible",
        cluster=cluster,
    )

def wait_for_index_absent(
    client: Any,
    database: str,
    table_name: str,
    index_name: str,
    *,
    cluster: str | None = None,
) -> None:
    """Poll ``system.data_skipping_indices`` until the index is gone."""
    _wait_for_system_rows(
        client,
        source="system.data_skipping_indices",
        where=(
            f"database = '{_quote(database)}' "
            f"AND table = '{_quote(table_name)}' "
            f"AND name = '{_quote(index_name)}'"
        ),
        want="absent",
        label=f"wait_for_index_absent: {database}.{table_name}.{index_name} still present",
        cluster=cluster,
    )

def wait_for_projection(
    client: Any,
    database: str,
    table_name: str,
    projection_name: str,
    *,
    cluster: str | None = None,
) -> None:
    """Poll ``system.projections`` until the projection appears."""
    _wait_for_system_rows(
        client,
        source="system.projections",
        where=(
            f"database = '{_quote(database)}' "
            f"AND table = '{_quote(table_name)}' "
            f"AND name = '{_quote(projection_name)}'"
        ),
        want="present",
        label=f"wait_for_projection: {database}.{table_name}.{projection_name} not yet visible",
        cluster=cluster,
    )

def wait_for_projection_absent(
    client: Any,
    database: str,
    table_name: str,
    projection_name: str,
    *,
    cluster: str | None = None,
) -> None:
    """Poll ``system.projections`` until the projection is gone."""
    _wait_for_system_rows(
        client,
        source="system.projections",
        where=(
            f"database = '{_quote(database)}' "
            f"AND table = '{_quote(table_name)}' "
            f"AND name = '{_quote(projection_name)}'"
        ),
        want="absent",
        label=(
            f"wait_for_projection_absent: {database}.{table_name}.{projection_name} "
            "still present"
        ),
        cluster=cluster,
    )

def _wait_for_system_rows(
    client: Any,
    *,
    source: str,
    where: str,
    want: Literal["present", "absent"],
    label: str,
    cluster: str | None,
) -> None:
    """Poll ``source`` until rows matching ``where`` are present (or absent).

    On a target with several replicas (#265) the wait holds until every
    replica shows the change: the next statement may land on any of them, and
    an ALTER that runs on a replica that has not applied the previous one can
    write back its stale schema. Pass the configured ``clickhouse.cluster``;
    without one the ``default`` cluster is probed (ObsessionDB).
    """
    fanout = resolve_replica_fanout(client, cluster)

    def _check() -> bool:
        if not _system_rows_match(client, source, where, want, fanout):
            raise RuntimeError(label)
        return True

    _poll(_check)


def _system_rows_match(
    client: Any,
    source: str,
    where: str,
    want: Literal["present", "absent"],
    fanout: ReplicaFanout | None,
) -> bool:
    if fanout is None:
        rows = client.query(f"SELECT 1 AS x FROM {source} WHERE {where}").rows
        return len(rows) > 0 if want == "present" else len(rows) == 0
    rows = client.query(
        "SELECT count(DISTINCT hostName()) AS replicas "
        f"FROM {all_replicas(fanout, source)} WHERE {where}"
    ).rows
    replicas = int(rows[0]["replicas"]) if rows else 0
    return replicas >= fanout.replicas if want == "present" else replicas == 0


def _parse_operation_key(
    operation_type: str, key: str
) -> tuple[str, str, str | None, str | None, str | None] | None:
    """Parse an operation key into (database, table, column, index, projection).

    Keys look like ``table:app.users``, ``table:app.users:column:name``,
    ``dictionary:app.users_dict``, ``view:app.active_users`` or
    ``materialized_view:app.events_mv:refresh``. ``table`` is the object's name
    in system.tables, which lists views and dictionaries too.

    Names may contain ':', so the object's name runs to the last occurrence of
    the suffix its operation type appends; without a known suffix the rest of
    the key is the name. The database runs to the first '.': the key cannot
    tell a '.' inside a database name from the separator, so objects in such a
    database are not found.
    """
    prefix = next((p for p in _OBJECT_KEY_PREFIXES if key.startswith(p)), None)
    if prefix is None:
        return None
    rest = key[len(prefix) :]
    dot = rest.find(".")
    if dot < 1 or dot == len(rest) - 1:
        return None
    database = rest[:dot]
    name = rest[dot + 1 :]

    suffix = _KEY_SUFFIXES.get(operation_type)
    at = -1 if suffix is None else name.rfind(suffix)
    if suffix is None or at < 1:
        return database, name, None, None, None
    member = name[at + len(suffix) :]
    return (
        database,
        name[:at],
        member if suffix == ":column:" else None,
        member if suffix == ":index:" else None,
        member if suffix == ":projection:" else None,
    )


def wait_for_ddl_propagation(  # noqa: PLR0911, PLR0912
    client: Any, operation_type: str, operation_key: str, *, cluster: str | None = None
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
    parsed = _parse_operation_key(operation_type, operation_key)
    if parsed is None:
        # database-level ops or unrecognised keys — nothing to poll for.
        return
    database, table, column, index, projection = parsed

    if operation_type in {"create_table", "alter_rename_table"}:
        wait_for_table(client, database, table, cluster=cluster)
        return
    if operation_type in {"create_view", "create_materialized_view"}:
        wait_for_view(client, database, table, cluster=cluster)
        return
    if operation_type == "create_dictionary":
        wait_for_dictionary(client, database, table, cluster=cluster)
        return
    if operation_type in {"alter_table_add_column", "alter_table_modify_column"}:
        if column is not None:
            wait_for_column(client, database, table, column, cluster=cluster)
        return
    if operation_type == "alter_table_drop_column":
        if column is not None:
            wait_for_column_absent(client, database, table, column, cluster=cluster)
        return
    if operation_type in {
        "drop_table",
        "drop_view",
        "drop_materialized_view",
        "drop_dictionary",
    }:
        wait_for_table_absent(client, database, table, cluster=cluster)
        return
    if operation_type == "alter_table_add_index" and index is not None:
        wait_for_index(client, database, table, index, cluster=cluster)
        return
    if operation_type == "alter_table_drop_index" and index is not None:
        wait_for_index_absent(client, database, table, index, cluster=cluster)
        return
    if operation_type == "alter_table_add_projection" and projection is not None:
        wait_for_projection(client, database, table, projection, cluster=cluster)
        return
    if operation_type == "alter_table_drop_projection" and projection is not None:
        wait_for_projection_absent(client, database, table, projection, cluster=cluster)
        return

    # alter_table_modify_setting, alter_table_modify_ttl, alter_table_reset_setting,
    # alter_materialized_view_modify_refresh, etc. → basic table presence check.
    wait_for_table(client, database, table, cluster=cluster)
