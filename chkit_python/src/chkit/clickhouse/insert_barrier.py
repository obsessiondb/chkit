"""Wait for the INSERTs that were running when a migration step started.

Port of ``packages/clickhouse/src/insert-barrier.ts``.

An INSERT builds its pipeline, including the materialized views it feeds,
when it starts. After a mirror view is created, the INSERTs that were already
running do not write to it. Every one of them is listed in
``system.processes`` until it ends, so once the ids listed after the view
existed on every replica are gone, every INSERT without the mirror has
committed. No clock is involved: the first read only has to happen after the
view exists, which is why a resumed run can simply read again.

On a target with several replicas ``system.processes`` is read through
``clusterAllReplicas``, because an INSERT runs on the replica that received it.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from typing import Any

from chkit.clickhouse.replicas import all_replicas, resolve_replica_fanout

DEFAULT_TIMEOUT_SECONDS = 10 * 60.0
DEFAULT_POLL_INTERVAL_SECONDS = 1.0
_PROGRESS_EVERY_SECONDS = 30.0
_SYSTEM_PROCESSES = re.compile(r"\bsystem\.processes\b")
_TRAILING_SEMICOLON = re.compile(r";\s*$")
_MAX_LISTED_IDS = 10


def wait_for_insert_barrier(
    client: Any,
    sql: str,
    *,
    cluster: str | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    log: Callable[[str], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> int:
    """Run ``sql`` (a SELECT over ``system.processes`` returning ``query_id``)
    once, then again until none of the query ids of the first run is listed.

    Returns how many INSERTs it waited for.
    """
    emit = log or (lambda _line: None)
    fanout = resolve_replica_fanout(client, cluster)
    query = sql
    if fanout is not None:
        source = all_replicas(fanout, "system.processes")
        query = _SYSTEM_PROCESSES.sub(lambda _match: source, sql, count=1)
    query = _TRAILING_SEMICOLON.sub("", query)

    def read() -> set[str]:
        return {str(row.get("query_id")) for row in client.query(query).rows}

    initial = read()
    if not initial:
        return 0
    noun = "query" if len(initial) == 1 else "queries"
    emit(f"  waiting for {len(initial)} running INSERT {noun} to finish")

    started = now()
    last_progress = started
    while True:
        sleep(poll_interval_seconds)
        current = read()
        remaining = sorted(query_id for query_id in initial if query_id in current)
        if not remaining:
            return len(initial)
        elapsed = now() - started
        if elapsed >= timeout_seconds:
            one = len(remaining) == 1
            listed = ", ".join(remaining[:_MAX_LISTED_IDS]) + (
                ", …" if len(remaining) > _MAX_LISTED_IDS else ""
            )
            msg = (
                f"{len(remaining)} INSERT {'query' if one else 'queries'} that started before "
                f"this step {'is' if one else 'are'} still running after {round(elapsed)}s "
                f"(query_id {listed}). Their rows may not be mirrored or snapshotted yet. "
                "Let them finish (or KILL QUERY them and retry those inserts after the "
                "cutover), then run chkit migrate --apply again: this step reads the running "
                "INSERTs anew."
            )
            raise RuntimeError(msg)
        if now() - last_progress >= _PROGRESS_EVERY_SECONDS:
            last_progress = now()
            noun = "query" if len(remaining) == 1 else "queries"
            emit(
                f"  still waiting for {len(remaining)} INSERT {noun} "
                f"(elapsed {round(elapsed)}s)"
            )
