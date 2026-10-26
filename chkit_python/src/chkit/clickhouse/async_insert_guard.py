"""Refuse to swap a table while fire-and-forget async inserts write to it.

Port of ``packages/clickhouse/src/async-insert-guard.ts``.

ClickHouse binds the async insert buffer of a table to its uuid. When the
table is renamed or exchanged before a buffer is flushed, the flush fails with
TABLE_UUID_MISMATCH and the buffered rows are dropped. A writer that waits for
the flush (``wait_for_async_insert = 1``) receives that error and can retry; a
fire-and-forget writer already got its acknowledgement, so its rows are lost
without a trace. A cutover swaps the table while writers keep inserting, so it
must not run while such writers are active.

``system.query_log`` is read on every replica, because an INSERT is logged by
the replica that received it. Only queries that went through the async queue
count (``ProfileEvents['AsyncInsertQuery']``), and a setting absent from
``Settings`` has its built-in default. A user who cannot read ``query_log``
gets a warning instead of a refusal.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from chkit.clickhouse.replicas import all_replicas, resolve_replica_fanout, string_literal

# How far back ``system.query_log`` is searched for fire-and-forget async inserts.
ASYNC_INSERT_WINDOW_MINUTES = 10


def assert_no_fire_and_forget_async_inserts(
    client: Any,
    tables: list[tuple[str, str]],
    *,
    cluster: str | None = None,
    log: Callable[[str], None] | None = None,
) -> None:
    """Raise when an asynchronous INSERT with ``wait_for_async_insert = 0``
    wrote to one of ``tables`` (database, name) in the last 10 minutes.

    ``cluster`` is ``clickhouse.cluster``; without it the ``default`` cluster
    is probed (ObsessionDB).
    """
    names = [f"{database}.{name}" for database, name in tables]
    fanout = resolve_replica_fanout(client, cluster)
    source = all_replicas(fanout, "system.query_log") if fanout else "system.query_log"
    try:
        rows = client.query(fire_and_forget_inserts_sql(source, names)).rows
    except Exception as error:  # any read failure only warns, as in TS
        if log is not None:
            first_line = str(error).split("\n")[0]
            log(
                "  warning: could not read system.query_log to check for fire-and-forget "
                f"async inserts into {', '.join(names)} ({first_line}). "
                "Make sure no writer uses async_insert = 1 with wait_for_async_insert = 0 "
                "on these tables."
            )
        return
    found = [row for row in rows if float(row.get("inserts") or 0) > 0]
    if not found:
        return
    counts = ", ".join(f"{row.get('inserts')} into {row.get('table')}" for row in found)
    msg = (
        "Fire-and-forget async inserts (async_insert = 1, wait_for_async_insert = 0) ran in "
        f"the last {ASYNC_INSERT_WINDOW_MINUTES} minutes: {counts}. "
        "ClickHouse drops the buffered rows of such an insert when its table is exchanged or "
        "renamed (TABLE_UUID_MISMATCH at flush), and the writer is never told. "
        "Switch these writers to wait_for_async_insert = 1 (an insert in flight at the swap "
        "then fails with a retryable error) or pause them, "
        f"wait {ASYNC_INSERT_WINDOW_MINUTES} minutes, and run chkit migrate --apply again."
    )
    raise RuntimeError(msg)


def fire_and_forget_inserts_sql(source: str, names: list[str]) -> str:
    def effective(setting: str) -> str:
        literal = string_literal(setting)
        return (
            f"if(mapContains(Settings, {literal}), Settings[{literal}], "
            f"(SELECT default FROM system.settings WHERE name = {literal}))"
        )

    listed = f"[{', '.join(string_literal(name) for name in names)}]"
    return " ".join(
        [
            f"SELECT arrayJoin(arrayIntersect(tables, {listed})) AS table, count() AS inserts "
            f"FROM {source}",
            "WHERE event_date >= yesterday() AND event_time >= now() - INTERVAL "
            f"{ASYNC_INSERT_WINDOW_MINUTES} MINUTE",
            "AND type = 'QueryFinish' AND query_kind = 'Insert' "
            "AND ProfileEvents['AsyncInsertQuery'] > 0",
            f"AND hasAny(tables, {listed})",
            f"AND {effective('wait_for_async_insert')} IN ('0', 'false')",
            "GROUP BY table ORDER BY table",
        ]
    )
