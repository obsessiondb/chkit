"""Chunks of a plan that already ran on the server.

Port of ``packages/plugin-backfill/src/executed-chunks.ts``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from chkit.clickhouse.replicas import all_replicas, resolve_replica_fanout

_PLAN_ID_RE = re.compile(r"^[a-f0-9]{16}$")


@dataclass(frozen=True)
class ExecutedChunks:
    """Chunk ids of a plan whose INSERT finished, or is still running, on the server."""

    finished: list[str]
    running: list[str]


def find_executed_chunks(
    *, executor: Any, plan_id: str, since: str, cluster: str | None = None
) -> ExecutedChunks:
    """Find the chunks of a plan that any earlier run or managed job already
    wrote, or is still writing.

    Every chunk query starts with the
    ``/* chkit backfill plan=<planId> chunk=<chunkId> … */`` header, so this
    finds them whatever query id ran them and whichever user the job backend
    used. Writing a finished chunk again duplicates its rows whenever the
    insert block differs (a copy of a table into itself reads its own earlier
    output), which the idempotency token does not prevent.

    Reads every replica of a multi-replica target, and fails rather than skip
    a replica. A chunk whose ``system.query_log`` entry has expired is not
    found.
    """
    if _PLAN_ID_RE.match(plan_id) is None:
        msg = f"Invalid backfill plan id: {plan_id}"
        raise ValueError(msg)
    try:
        since_time = datetime.fromisoformat(since.replace("Z", "+00:00"))
    except ValueError as error:
        msg = f"Invalid plan creation time: {since}"
        raise ValueError(msg) from error

    fanout = resolve_replica_fanout(executor, cluster)

    def source(table: str) -> str:
        return all_replicas(fanout, table) if fanout else table

    header = f"startsWith(query, '/* chkit backfill plan={plan_id} chunk=')"
    chunk_id = (
        "extract(query, '^/\\\\* chkit backfill plan=[0-9a-f]+ chunk=([0-9a-f]+) ')"
    )
    # The day before the plan's UTC date, so a server time zone cannot hide a query.
    since_day = (since_time - timedelta(days=1)).date().isoformat()

    # One after the other, and running queries first: a chunk that finishes
    # between the two reads then shows up in one of them.
    running = executor.query(
        f"SELECT DISTINCT {chunk_id} AS chunk_id FROM {source('system.processes')}\n"
        f"WHERE {header}\n"
        "SETTINGS skip_unavailable_shards = 0"
    )
    finished = executor.query(
        f"SELECT DISTINCT {chunk_id} AS chunk_id FROM {source('system.query_log')}\n"
        f"WHERE event_date >= toDate('{since_day}')\n"
        "  AND type = 'QueryFinish'\n"
        "  AND is_initial_query = 1\n"
        f"  AND {header}\n"
        "SETTINGS skip_unavailable_shards = 0"
    )
    return ExecutedChunks(finished=_chunk_ids(finished), running=_chunk_ids(running))


def _chunk_ids(result: object) -> list[str]:
    rows = getattr(result, "rows", result)
    if not isinstance(rows, list):
        return []
    ids = {
        str(row["chunk_id"])
        for row in rows
        if isinstance(row, dict) and row.get("chunk_id")
    }
    return sorted(ids)


__all__ = ["ExecutedChunks", "find_executed_chunks"]
