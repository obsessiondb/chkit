"""Backfill resume against the 2-shard x 2-replica cluster (#289).

Port of the backfill case in ``packages/cli/test/cluster-2shard.e2e.test.ts``.
A chunk query runs on the node that received it; a resume whose requests reach
another node must see the chunk running and poll it, instead of submitting it
again.

Opt-in like the TS cluster tests (outside ``testpaths``). Start the cluster
with ``bun run cluster:2shard:up``, then run::

    .venv/bin/python -m pytest tests_cluster

Hard-fails (never skips) when the cluster is unreachable.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from collections.abc import Callable

from chkit.clickhouse.client import ClickHouseClient, QueryResult, QueryStatus
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.async_backfill import execute_backfill
from chkit_plugin_backfill.types import BackfillChunkState, BackfillProgress

_NODES = os.environ.get(
    "CHKIT_CLUSTER_2S_NODES",
    "http://localhost:8133,http://localhost:8134,http://localhost:8135,http://localhost:8136",
).split(",")
_CLUSTER = os.environ.get("CHKIT_CLUSTER_2S", "test_cluster_2s")
_USER = os.environ.get("CLICKHOUSE_USER", "default")
_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "clusterpass")
_DATABASE = os.environ.get("CLICKHOUSE_DB", "default")
# About 6 s.
_CHUNK_SQL = "SELECT sleepEachRow(0.3) FROM numbers(20) SETTINGS max_block_size = 1"


def test_resume_through_another_replica_reports_running_chunk() -> None:
    # _NODES[0] and _NODES[1] are the two replicas of shard 1.
    submitter = _connect(_NODES[0], cluster=None)
    # The other replica of shard 1, configured like the run that resumes.
    other_replica = _connect(_NODES[1], cluster=_CLUSTER)
    plan_id = f"py_twoshard_bf_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    chunk_id = "c0"
    query_id = f"backfill-{plan_id}-{chunk_id}"

    def run_chunk() -> None:
        # Its own client, since a client runs one query at a time.
        with _connect(_NODES[0], cluster=None) as lost_run:
            lost_run.submit(_CHUNK_SQL, query_id=query_id)

    worker = threading.Thread(target=run_chunk)
    try:
        worker.start()
        processes_sql = f"SELECT count() FROM system.processes WHERE query_id = '{query_id}'"
        _poll_until(lambda: _count(submitter, processes_sql) == 1)
        # The other replica's own system.processes does not show the chunk.
        assert _count(other_replica, processes_sql) == 0

        recording = _RecordingExecutor(other_replica)
        snapshots: list[BackfillChunkState] = []

        def on_progress(progress: BackfillProgress) -> None:
            state = progress.get(chunk_id)
            if state is not None:
                snapshots.append(state)

        result = execute_backfill(
            executor=recording,
            cluster=_CLUSTER,
            plan_id=plan_id,
            chunk_ids=[chunk_id],
            build_query=lambda _chunk_id: _CHUNK_SQL,
            concurrency=1,
            poll_interval_ms=250,
            # A run that stopped between submitting the chunk and recording it.
            resume_from={chunk_id: BackfillChunkState(status="pending")},
            on_progress=on_progress,
        )

        assert snapshots[0].status == "running"
        assert snapshots[0].query_id == query_id
        assert recording.submitted == []
        assert result.progress[chunk_id].status == "done"
    finally:
        worker.join(timeout=60)
        submitter.close()
        other_replica.close()


class _RecordingExecutor:
    """Delegates to a native client and records submissions."""

    def __init__(self, inner: ClickHouseClient) -> None:
        self._inner = inner
        self.submitted: list[str] = []

    def query(self, statement: str) -> QueryResult:
        return self._inner.query(statement)

    def submit(self, statement: str, query_id: str | None = None) -> str:
        self.submitted.append(query_id or statement)
        return self._inner.submit(statement, query_id=query_id)

    def query_status(self, query_id: str, *, after_time: str | None = None) -> QueryStatus:
        return self._inner.query_status(query_id, after_time=after_time)


def _connect(url: str, *, cluster: str | None) -> ClickHouseClient:
    return ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=url,
            username=_USER,
            password=_PASSWORD,
            database=_DATABASE,
            secure=False,
            cluster=cluster,
        )
    )


def _count(client: ClickHouseClient, sql: str) -> int:
    return int(client.query(sql).rows[0]["count()"])


def _poll_until(done: Callable[[], bool], *, timeout: float = 30.0, interval: float = 0.1) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if done():
            return
        time.sleep(interval)
    msg = f"condition not met within {timeout}s"
    raise AssertionError(msg)
