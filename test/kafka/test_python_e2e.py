"""Opt-in native Python CLI Kafka workflow against test/kafka/docker-compose.yml."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import clickhouse_connect


def test_python_kafka_pipeline(tmp_path: Path) -> None:
    tag = f"{time.time_ns()}"
    database, topic, journal = (
        f"chkit_py_kafka_{tag}",
        f"chkit_py_{tag}",
        f"_chkit_py_{tag}",
    )
    url = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:18203")
    address = urlparse(url)
    password = "chkit-kafka-test"
    db = clickhouse_connect.get_client(
        host=address.hostname, port=address.port, username="default", password=password
    )
    compose = [
        "docker",
        "compose",
        "-p",
        os.environ.get("KAFKA_TEST_PROJECT", "chkit-issue203"),
        "-f",
        str(Path(__file__).with_name("docker-compose.yml")),
    ]

    def broker(args: list[str], stdin: str | None = None) -> None:
        subprocess.run(
            [*compose, "exec", "-T", "kafka", "rpk", *args],
            input=stdin,
            text=True,
            capture_output=True,
            check=True,
        )

    def source(include_queue: bool, consumers: int = 1) -> str:
        return f"""from chkit import schema, table, materialized_view
storage = table(database={database!r}, name="events", engine="MergeTree",
    columns=[{{"name": "id", "type": "UInt64"}}, {{"name": "body", "type": "String"}}],
    primary_key=["id"], order_by=["id"], settings={{"index_granularity": 8192}})
""" + (
            f"""
queue = table(database={database!r}, name="queue", engine="Kafka", columns=list(storage.columns),
    settings={{"kafka_broker_list": "kafka:9092", "kafka_topic_list": {topic!r},
        "kafka_group_name": {topic!r}, "kafka_format": "JSONEachRow",
        "kafka_client_id": {"client; COMMENT 'quoted' " + chr(92)!r},
        "kafka_num_consumers": {consumers}, "kafka_flush_interval_ms": 100,
        "kafka_commit_on_select": False, "input_format_skip_unknown_fields": True}})
mv = materialized_view(database={database!r}, name="consumer",
    to={{"database": {database!r}, "name": "events"}}, as_="SELECT id, body FROM {database}.queue")
definitions = schema(storage, queue, mv)
"""
            if include_queue
            else "definitions = schema(storage)\n"
        )

    def cli(args: list[str], success: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [
                str(Path(sys.executable).with_name("chkit")),
                *args,
                "--config",
                str(tmp_path / "clickhouse.config.py"),
                "--json",
            ],
            cwd=tmp_path,
            env={**os.environ, "CHKIT_JOURNAL_TABLE": journal},
            text=True,
            capture_output=True,
            check=False,
        )
        if success:
            assert result.returncode == 0, result.stdout + result.stderr
        return result

    def wait_for_ids(ids: list[int]) -> None:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            actual = [
                row[0]
                for row in db.query(
                    f"SELECT id FROM {database}.events ORDER BY id"
                ).result_rows
            ]
            if actual == ids:
                return
            time.sleep(0.2)
        assert actual == ids

    schema_file = tmp_path / "schema.py"
    try:
        schema_file.write_text(source(True))
        (tmp_path / "clickhouse.config.py").write_text(
            f"config = {{'schema': './schema.py', 'outDir': './chkit', 'clickhouse': "
            f"{{'url': {url!r}, 'username': 'default', 'password': {password!r}, 'database': 'default'}}}}"
        )
        broker(["topic", "create", topic, "-p", "2"])
        cli(["generate", "--name", "create", "--migration-id", "001"])
        cli(["migrate", "--apply"])
        broker(
            ["topic", "produce", topic],
            '{"id":1,"body":"hello","ignored":true}\n{"id":2,"body":"world"}\n',
        )
        wait_for_ids([1, 2])
        assert json.loads(cli(["drift", "--live"]).stdout)["drifted"] is False
        cli(["check", "--live"])

        pulled = tmp_path / "pulled.py"
        cli(["pull", "--database", database, "--out-file", str(pulled)])
        schema_file.write_text(pulled.read_text())
        plan = cli(["generate", "--dryrun"])
        assert json.loads(plan.stdout)["operationCount"] == 0, plan.stdout

        snapshot_file = tmp_path / "chkit/meta/snapshot.json"
        before = snapshot_file.read_text()
        snapshot = json.loads(before)
        next(d for d in snapshot["definitions"] if d["name"] == "queue")["settings"][
            "kafka_group_name"
        ] = "other"
        snapshot_file.write_text(json.dumps(snapshot))
        assert "kafka_group_name" in cli(["drift", "--live"]).stdout
        assert "kafka_change_requires_replacement" in cli(["drift"]).stdout
        for flags in ([], ["--live"]):
            result = cli(["check", *flags], success=False)
            assert result.returncode != 0
            assert "kafka_change_requires_replacement" in result.stdout
        snapshot_file.write_text(before)

        schema_file.write_text(source(True, 2))
        migrations = sorted((tmp_path / "chkit/migrations").iterdir())
        blocked = cli(["generate", "--name", "unsafe"], success=False)
        assert blocked.returncode != 0
        assert "kafka_change_requires_replacement" in blocked.stdout + blocked.stderr
        assert snapshot_file.read_text() == before
        assert sorted((tmp_path / "chkit/migrations").iterdir()) == migrations

        schema_file.write_text(source(False))
        cli(["generate", "--name", "stop", "--migration-id", "002"])
        schema_file.write_text(source(True, 2))
        cli(["generate", "--name", "restart", "--migration-id", "003"])
        assert cli(["migrate", "--apply"], success=False).returncode != 0
        cli(["migrate", "--apply", "--allow-destructive"])
        broker(["topic", "produce", topic], '{"id":3,"body":"after replacement"}\n')
        wait_for_ids([1, 2, 3])
        cli(["check", "--live"])
    finally:
        db.command(f"DROP DATABASE IF EXISTS {database} SYNC")
        db.command(f"DROP TABLE IF EXISTS default.{journal} SYNC")
        db.close()
        broker(["topic", "delete", topic])
