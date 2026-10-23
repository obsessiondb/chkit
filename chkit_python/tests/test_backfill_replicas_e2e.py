"""Port of ``packages/plugin-backfill/src/async-backfill-replicas.e2e.test.ts`` (#289).

A chunk query runs on the replica that received it. On a multi-replica
service (ObsessionDB, without ``clickhouse.cluster``) a resume whose reads
land on another replica used to miss the running chunk and submit it again.
The test submits until a chunk runs on a replica other than the one the
resuming client reads from; the single-node local stack has only that replica.

Hard-fails (never skips) when the server is unreachable.
"""

from __future__ import annotations

import threading

from chkit.clickhouse.client import ClickHouseClient, QueryResult, QueryStatus
from chkit.clickhouse.replicas import ReplicaFanout, all_replicas, resolve_replica_fanout
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.async_backfill import execute_backfill
from chkit_plugin_backfill.types import BackfillChunkState, BackfillProgress
from tests.e2e_testkit import LiveEnv, create_prefix, poll_until, resolve_live_env

# About 10 s, long enough to resume while it runs.
_CHUNK_SQL = "SELECT sleepEachRow(0.5) FROM numbers(20) SETTINGS max_block_size = 1"
_MAX_SUBMITS = 8


def test_chunk_running_on_another_replica_resumes_as_running() -> None:
    env = resolve_live_env()
    observer = _connect(env)
    plan_id = create_prefix("py_bf_replicas")[:-1]
    workers: list[threading.Thread] = []
    try:
        observer_host = _host_of(observer)
        fanout = resolve_replica_fanout(observer)

        chunk_id: str | None = None
        running_host = ""
        for index in range(_MAX_SUBMITS):
            candidate = f"c{index}"
            query_id = f"backfill-{plan_id}-{candidate}"
            # A new client is a new connection, which the load balancer may
            # send to any replica. submit() blocks until the query finishes.
            worker = threading.Thread(target=_submit, args=(env, query_id), daemon=True)
            worker.start()
            workers.append(worker)
            hosts = poll_until(
                lambda query_id=query_id: _running_hosts(observer, fanout, query_id),
                lambda found: len(found) > 0,
                interval=0.1,
            )
            running_host = hosts[0] if hosts else ""
            if fanout is None or running_host != observer_host:
                chunk_id = candidate
                break
        assert chunk_id is not None, (
            f"no chunk ran on a replica other than {observer_host} "
            f"within {_MAX_SUBMITS} submits"
        )
        query_id = f"backfill-{plan_id}-{chunk_id}"

        recording = _RecordingExecutor(observer)
        snapshots: list[BackfillChunkState] = []

        def on_progress(progress: BackfillProgress) -> None:
            state = progress.get(chunk_id)
            if state is not None:
                snapshots.append(state)

        result = execute_backfill(
            executor=recording,
            plan_id=plan_id,
            chunk_ids=[chunk_id],
            build_query=lambda _chunk_id: _CHUNK_SQL,
            concurrency=1,
            poll_interval_ms=250,
            # A run that stopped between submitting the chunk and recording it.
            resume_from={chunk_id: BackfillChunkState(status="pending")},
            on_progress=on_progress,
        )

        assert snapshots[0].status == "running", (
            f"resume state of {query_id} running on {running_host}: {snapshots[0]}"
        )
        assert snapshots[0].query_id == query_id
        assert recording.submitted == []
        assert result.progress[chunk_id].status == "done"
    finally:
        for worker in workers:
            worker.join(timeout=60)
        observer.close()


def _connect(env: LiveEnv) -> ClickHouseClient:
    return ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https"),
        )
    )


def _submit(env: LiveEnv, query_id: str) -> None:
    with _connect(env) as submitter:
        submitter.submit(_CHUNK_SQL, query_id=query_id)


def _host_of(client: ClickHouseClient) -> str:
    return str(client.query("SELECT hostName() AS host").rows[0]["host"])


def _running_hosts(
    client: ClickHouseClient, fanout: ReplicaFanout | None, query_id: str
) -> list[str]:
    source = all_replicas(fanout, "system.processes") if fanout else "system.processes"
    rows = client.query(
        f"SELECT hostName() AS host FROM {source} WHERE query_id = '{query_id}'"
    ).rows
    return [str(row["host"]) for row in rows]


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
