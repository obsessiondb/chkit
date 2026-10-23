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

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from chkit.clickhouse.alter_column_statement import (
    ColumnIntent,
    parse_modify_column_intent,
    parse_rename_column,
)
from chkit.clickhouse.replicas import ReplicaFanout, all_replicas, resolve_replica_fanout

MAX_ATTEMPTS = 20
RETRY_DELAY_SECONDS = 0.5
# Upper bound on a column definition or rename wait.
DEFINITION_WAIT_DEADLINE_SECONDS = 30.0


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
    "alter_table_add_constraint": ":constraint:",
    "alter_table_drop_constraint": ":constraint:",
    "alter_table_modify_setting": ":setting:",
    "alter_table_reset_setting": ":setting:",
    "alter_table_modify_ttl": ":ttl",
    "alter_table_rename_table": ":rename_table",
    "rename_dictionary": ":rename_dictionary",
}
_OBJECT_KEY_PREFIXES = ("table:", "dictionary:", "view:", "materialized_view:")

# The ``system.columns`` fields a column definition wait compares.
_COLUMN_FIELDS = ("type", "default_kind", "default_expression", "comment", "compression_codec")


@dataclass(frozen=True)
class _ExpectedColumnValue:
    """A field value the statement sets; ``prefix`` matches the start only."""

    field: str
    value: str
    prefix: bool = False


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
    """Wait until every replica's catalog lists this dictionary.

    ``system.dictionaries`` is each replica's in-memory loader, not the
    replicated catalog. ``CREATE OR REPLACE DICTIONARY`` drops that loader
    entry while the replica reloads, so the dictionary can be missing there
    after the DDL is already in ``system.tables``. On several replicas the
    wait holds until every replica stores the same non-nil ``uuid``. A
    replace does not remove the row, and ClickHouse redacts a SOURCE password
    to ``[HIDDEN]`` in ``create_table_query``, so a password-only replace
    compares equal to the previous definition. ``CREATE OR REPLACE`` still
    assigns one new UUID in the replicated DDL, and every replica that has
    applied it reports that UUID. ``metadata_modification_time`` is each
    replica's metadata-file mtime at second precision, so it can stay
    unchanged across a replace and differ between replicas that applied it.
    """
    where = (
        f"database = '{_quote(database)}' AND name = '{_quote(dictionary_name)}' "
        "AND engine = 'Dictionary'"
    )
    label = f"wait_for_dictionary: {database}.{dictionary_name} not yet visible"
    fanout = resolve_replica_fanout(client, cluster)

    def _check() -> bool:
        if not _dictionary_catalog_visible(client, where, fanout):
            raise RuntimeError(label)
        return True

    _poll(_check)

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

def wait_for_constraint(
    client: Any,
    database: str,
    table_name: str,
    constraint_name: str,
    *,
    cluster: str | None = None,
) -> None:
    """Poll every replica's ``create_table_query`` until it lists the constraint.

    There is no system table of constraints. A replica that has not applied the
    ADD yet would let a following ``DROP CONSTRAINT IF EXISTS`` or ``ADD
    CONSTRAINT IF NOT EXISTS`` silently do nothing.
    """
    _wait_for_system_rows(
        client,
        source="system.tables",
        where=_constraint_where(database, table_name, constraint_name),
        want="present",
        label=f"wait_for_constraint: {database}.{table_name}.{constraint_name} not yet visible",
        cluster=cluster,
    )


def wait_for_constraint_absent(
    client: Any,
    database: str,
    table_name: str,
    constraint_name: str,
    *,
    cluster: str | None = None,
) -> None:
    """Poll every replica's ``create_table_query`` until the constraint is gone."""
    _wait_for_system_rows(
        client,
        source="system.tables",
        where=_constraint_where(database, table_name, constraint_name),
        want="absent",
        label=(
            f"wait_for_constraint_absent: {database}.{table_name}.{constraint_name} "
            "still present"
        ),
        cluster=cluster,
    )


def wait_for_column_definition(
    client: Any,
    database: str,
    table_name: str,
    column_name: str,
    intent: ColumnIntent,
    *,
    cluster: str | None = None,
) -> None:
    """Wait until every replica reports the column with one definition.

    Agreement: the replica that ran an ALTER has applied it when the statement
    returns, so once every replica reports the same ``type``,
    ``default_kind``, ``default_expression``, ``comment`` and
    ``compression_codec``, all of them have. Each replica formats these values
    itself, so the comparison never trips over how chkit wrote an expression.

    Intent: agreement alone passes when every replica kept the old definition,
    e.g. ObsessionDB ignoring ``MODIFY COLUMN ... EPHEMERAL <default>`` (#285).
    So the fields the statement sets are compared too: the default kind and
    comment verbatim, a removed codec as empty, and the default expression
    after the server formats it with ``formatQuerySingleLine``, the formatter
    that writes ``system.columns.default_expression``. Types and codecs the
    statement sets are only compared between replicas: ClickHouse rewrites
    them (``Decimal(10,2)`` becomes ``Decimal(10, 2)``, ``ZSTD`` becomes
    ``ZSTD(1)``).
    """
    fanout = resolve_replica_fanout(client, cluster)
    expected = _expected_column_values(client, intent)
    source = all_replicas(fanout, "system.columns") if fanout else "system.columns"
    sql = (
        f"SELECT hostName() AS replica, {', '.join(_COLUMN_FIELDS)} FROM {source} "
        f"WHERE database = '{_quote(database)}' AND table = '{_quote(table_name)}' "
        f"AND name = '{_quote(column_name)}'"
    )
    replicas = fanout.replicas if fanout else 1
    _wait_until_applied(
        f"{database}.{table_name}.{column_name} definition",
        lambda: _column_definition_mismatch(client.query(sql).rows, replicas, expected),
    )


def wait_for_column_rename(
    client: Any,
    database: str,
    table_name: str,
    from_: str,
    to: str,
    *,
    cluster: str | None = None,
) -> None:
    """Wait until no replica lists the old name and every replica lists the new one."""
    fanout = resolve_replica_fanout(client, cluster)
    replicas = fanout.replicas if fanout else 1
    source = all_replicas(fanout, "system.columns") if fanout else "system.columns"
    sql = (
        f"SELECT hostName() AS replica, name FROM {source} "
        f"WHERE database = '{_quote(database)}' AND table = '{_quote(table_name)}' "
        f"AND name IN ('{_quote(from_)}', '{_quote(to)}')"
    )

    def _check() -> str | None:
        rows = client.query(sql).rows
        stale = [str(row.get("replica")) for row in rows if row.get("name") == from_]
        if stale:
            return f"replica {', '.join(stale)} still lists column {from_}"
        renamed = {row.get("replica") for row in rows if row.get("name") == to}
        if len(renamed) < replicas:
            return f"column {to} is listed on {len(renamed)} of {replicas} replicas"
        return None

    _wait_until_applied(f"{database}.{table_name} rename of column {from_} to {to}", _check)


def _wait_until_applied(subject: str, check: Callable[[], str | None]) -> None:
    """Poll ``check`` until it reports no mismatch.

    Uses the retry budget of the other waits (21 checks, 0.5 s apart) and stops
    retrying at a 30 s deadline (TS also abandons a check that does not
    return by then; a synchronous query here is bounded by the client's
    receive timeout). On timeout the error names what was still different on
    the last check.
    """
    deadline = time.monotonic() + DEFINITION_WAIT_DEADLINE_SECONDS
    detail = ""
    checks = 0
    for attempt in range(MAX_ATTEMPTS + 1):
        checks += 1
        try:
            mismatch = check()
        except Exception as error:  # reported on timeout
            mismatch = str(error)
        if mismatch is None:
            return
        detail = mismatch
        if attempt == MAX_ATTEMPTS or time.monotonic() + RETRY_DELAY_SECONDS >= deadline:
            break
        time.sleep(RETRY_DELAY_SECONDS)
    msg = (
        f"wait_for_ddl_propagation: {subject} not applied on every replica "
        f"after {checks} checks: {detail}"
    )
    raise RuntimeError(msg)


def _expected_column_values(client: Any, intent: ColumnIntent) -> list[_ExpectedColumnValue]:
    """The ``system.columns`` values ``intent`` pins down.

    The default expression is formatted by the server; when it cannot be
    formatted (a server without ``formatQuerySingleLine``), the expression is
    left to the agreement check.
    """
    expected: list[_ExpectedColumnValue] = []
    if intent.default_kind is not None:
        expected.append(_ExpectedColumnValue("default_kind", intent.default_kind))
    if intent.default_kind == "":
        expected.append(_ExpectedColumnValue("default_expression", ""))
    if intent.type_default:
        expected.append(
            _ExpectedColumnValue("default_expression", "defaultValueOfTypeName(", prefix=True)
        )
    if intent.comment is not None:
        expected.append(_ExpectedColumnValue("comment", intent.comment))
    if intent.codec_removed:
        expected.append(_ExpectedColumnValue("compression_codec", ""))
    if intent.default_expression is not None:
        formatted = _format_expression(client, intent.default_expression)
        if formatted is not None:
            expected.append(_ExpectedColumnValue("default_expression", formatted))
    return expected


def _format_expression(client: Any, expression: str) -> str | None:
    select = "SELECT "
    try:
        rows = client.query(
            f"SELECT formatQuerySingleLine('{_quote(select + expression)}') AS formatted"
        ).rows
    except Exception:  # left to the agreement check
        return None
    formatted = rows[0].get("formatted") if rows else None
    if not isinstance(formatted, str) or not formatted.startswith(select):
        return None
    return formatted[len(select) :]


def _column_definition_mismatch(
    rows: list[dict[str, Any]],
    replicas: int,
    expected: list[_ExpectedColumnValue],
) -> str | None:
    """Why the replicas' rows do not show the intended definition yet, or None."""

    def value(row: dict[str, Any], field: str) -> str:
        return str(row.get(field) or "")

    listed = list(dict.fromkeys(str(row.get("replica")) for row in rows))
    if len(listed) < replicas:
        where = f" ({', '.join(listed)})" if listed else ""
        return f"the column is listed on {len(listed)} of {replicas} replicas{where}"
    for row in rows:
        off = next(
            (
                want
                for want in expected
                if not (
                    value(row, want.field).startswith(want.value)
                    if want.prefix
                    else value(row, want.field) == want.value
                )
            ),
            None,
        )
        if off is None:
            continue
        sets = f"{_json(off.value)}..." if off.prefix else _json(off.value)
        actual = value(row, off.field)
        unanimous = len(rows) > 1 and all(value(other, off.field) == actual for other in rows)
        lag = (
            "; every replica reports the same, so this is not replication lag: "
            "the server accepted the statement without applying it"
            if unanimous
            else ""
        )
        return (
            f"replica {row.get('replica')} reports {off.field} {_json(actual)}, "
            f"the statement sets {sets}{lag}"
        )
    if not rows:
        return None
    first = rows[0]
    for row in rows[1:]:
        field = next((f for f in _COLUMN_FIELDS if value(row, f) != value(first, f)), None)
        if field is not None:
            return (
                f"replica {row.get('replica')} reports {field} {_json(value(row, field))}, "
                f"replica {first.get('replica')} reports {_json(value(first, field))}"
            )
    return None


def _json(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _renamed_column(member: str, statement: str | None) -> tuple[str, str] | None:
    """The old and new names of a column rename.

    The statement names them; without it the key's ``<from>:<to>`` is split
    only when it holds exactly one ':'.
    """
    parsed = parse_rename_column(statement) if statement is not None else None
    if parsed is not None and f"{parsed[0]}:{parsed[1]}" == member:
        return parsed
    parts = member.split(":")
    if len(parts) == 2 and parts[0] and parts[1]:  # noqa: PLR2004
        return parts[0], parts[1]
    return None


def _constraint_where(database: str, table_name: str, constraint_name: str) -> str:
    # ClickHouse writes a constraint name bare when it is a plain identifier
    # and backquoted otherwise (`backQuoteIfNeed`), so match either spelling.
    escaped = constraint_name.replace("\\", "\\\\").replace("`", "\\`")
    spellings = [f"CONSTRAINT {constraint_name} ", f"CONSTRAINT `{escaped}` "]
    listed = " OR ".join(
        f"position(create_table_query, '{_quote(spelling)}') > 0" for spelling in spellings
    )
    return f"database = '{_quote(database)}' AND name = '{_quote(table_name)}' AND ({listed})"


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


def _dictionary_catalog_visible(
    client: Any,
    where: str,
    fanout: ReplicaFanout | None,
) -> bool:
    if fanout is None:
        rows = client.query(f"SELECT 1 AS x FROM system.tables WHERE {where}").rows
        return len(rows) > 0
    rows = client.query(
        "SELECT count(DISTINCT hostName()) AS replicas, "
        "(min(uuid) = max(uuid) "
        "AND min(uuid) != toUUID('00000000-0000-0000-0000-000000000000') "
        "AND count(uuid) = count()) AS agreed "
        f"FROM {all_replicas(fanout, 'system.tables')} WHERE {where}"
    ).rows
    if not rows:
        return False
    replicas = int(rows[0]["replicas"])
    return replicas >= fanout.replicas and _is_agreed(rows[0].get("agreed"))


def _is_agreed(value: object) -> bool:
    return value is True or value in {1, "1"}


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
    client: Any,
    operation_type: str,
    operation_key: str,
    *,
    cluster: str | None = None,
    statement: str | None = None,
) -> None:
    """Dispatch the right ``wait_for_*`` based on the operation type + key.

    Operation-type → wait predicate map (mirrors TS ddl-propagation.ts):

    - create_table / alter_rename_table              → wait_for_table
    - create_view / create_materialized_view         → wait_for_view
    - create_dictionary                               → wait_for_dictionary
    - drop_dictionary                                 → wait_for_table_absent
    - alter_table_add_column / alter_table_modify_column → wait_for_column_definition
      (MODIFY also checks what ``statement`` sets)
    - alter_table_rename_column                       → wait_for_column_rename
    - alter_table_drop_column                         → wait_for_column_absent
    - drop_table / drop_view / drop_materialized_view → wait_for_table_absent
    - alter_table_add_index                           → wait_for_index
    - alter_table_drop_index                          → wait_for_index_absent
    - alter_table_add_projection                      → wait_for_projection
    - alter_table_drop_projection                     → wait_for_projection_absent
    - alter_table_add_constraint                      → wait_for_constraint
    - alter_table_drop_constraint                     → wait_for_constraint_absent
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
    # ADD COLUMN IF NOT EXISTS leaves an existing column as it is, so only
    # agreement between replicas is checked; MODIFY also checks what it sets.
    if operation_type in {"alter_table_add_column", "alter_table_modify_column"}:
        if column is not None:
            intent = (
                parse_modify_column_intent(statement, column)
                if operation_type == "alter_table_modify_column" and statement is not None
                else ColumnIntent()
            )
            wait_for_column_definition(client, database, table, column, intent, cluster=cluster)
        return
    if operation_type == "alter_table_rename_column":
        suffix = ":column_rename:"
        member = operation_key[operation_key.rfind(suffix) + len(suffix) :]
        rename = _renamed_column(member, statement) if suffix in operation_key else None
        if rename is not None:
            wait_for_column_rename(client, database, table, *rename, cluster=cluster)
        else:
            wait_for_table(client, database, table, cluster=cluster)
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
    if operation_type in {"alter_table_add_constraint", "alter_table_drop_constraint"}:
        constraint = operation_key[operation_key.rfind(":constraint:") + len(":constraint:") :]
        wait = (
            wait_for_constraint
            if operation_type == "alter_table_add_constraint"
            else wait_for_constraint_absent
        )
        wait(client, database, table, constraint, cluster=cluster)
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
