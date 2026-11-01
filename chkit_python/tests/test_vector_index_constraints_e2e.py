"""Port of ``packages/cli/src/test/vector-index-constraints.e2e.test.ts`` (#278).

vector_similarity skip indexes, raw indexes and table constraints: declared in
the DSL, migrated, read back by drift and pull, changed out of band and in the
schema, and dropped together with the column they read. Needs ClickHouse 25.8+.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands.pull import _introspected_table_to_definition
from chkit.cli.commands.pull_render import render_schema_file
from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.introspect import list_table_details
from chkit.core.model import ChxResolvedClickHouseConfig, TableConstraintDefinition
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    poll_until,
    resolve_live_env,
)

VECTOR = (
    "{'name': 'embedding_hnsw', 'expression': 'embedding', 'type': 'vector_similarity', "
    "'method': 'hnsw', 'distanceFunction': 'cosineDistance', 'dimensions': 4}"
)
RAW = "{'name': 'sg', 'expression': 's', 'type': 'raw', 'rawType': 'sparse_grams(3,20, 256,2,0)', 'granularity': 1}"
CONSTRAINTS = [
    "{'name': 'dimension', 'check': 'length(embedding) = 4'}",
    # ClickHouse stores this as `(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)`.
    "{'name': 'allowed', 'check': \"s IN ('a','b') AND (id+1)*2 > 0\"}",
    "{'name': 'positive-id', 'assume': 'id > 0'}",
]
CHANGED_VECTOR = (
    "{'name': 'embedding_hnsw', 'expression': 'embedding', 'type': 'vector_similarity', "
    "'method': 'hnsw', 'distanceFunction': 'L2Distance', 'dimensions': 4, 'quantization': 'f32', "
    "'hnswMaxConnectionsPerLayer': 16, 'hnswCandidateListSizeForConstruction': 64}"
)
CHANGED_CONSTRAINTS = [
    "{'name': 'dimension', 'check': 'length(embedding) = 4'}",
    "{'name': 'allowed', 'check': \"s IN ('a','b','c')\"}",
    "{'name': 'small-id', 'assume': 'id < 1000000'}",
]
COLUMNS = ["id UInt64", "s String", "embedding Array(Float32)"]


def _render_schema(
    database: str, name: str, columns: list[str], indexes: list[str], constraints: list[str]
) -> str:
    column_dicts = [
        f"{{'name': {c.split()[0]!r}, 'type': {c.split(maxsplit=1)[1]!r}}}" for c in columns
    ]
    return "\n".join([
        "from chkit import schema, table",
        "",
        "definitions = schema(",
        f"    table(database={database!r}, name={name!r}, engine='MergeTree()', "
        "primary_key=['id'], order_by=['id'],",
        f"        columns=[{', '.join(column_dicts)}],",
        f"        indexes=[{', '.join(indexes)}],",
        f"        constraints=[{', '.join(constraints)}],",
        "    ),",
        ")",
        "",
    ])


def _retry(run: Callable[[], Any], ok: Callable[[Any], bool], attempts: int = 20) -> Any:
    result = run()
    for _ in range(attempts):
        if ok(result):
            return result
        time.sleep(1)
        result = run()
    return result


def test_vector_index_and_constraints_round_trip(  # noqa: PLR0915
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = ch_client._client
    version = str(client.query("SELECT version()").result_rows[0][0])
    major, minor = (int(part) for part in version.split(".")[:2])
    assert (major, minor) >= (25, 8), f"ClickHouse {version} predates vector search GA (25.8)"

    env = resolve_live_env()
    database = client.database
    name = f"{create_prefix('py_vec')}vectors"
    full_name = f"{database}.{name}"
    monkeypatch.chdir(tmp_path)
    journal_table = create_journal_table_name("py_vec")
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    runner = CliRunner()
    schema_path = tmp_path / "schema.py"
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\nconfig = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "outDir": "./chkit",
            "migrationsDir": "./chkit/migrations",
            "metaDir": "./chkit/meta",
            "clickhouse": {
                "url": env.clickhouse_url,
                "username": env.clickhouse_user,
                "password": env.clickhouse_password,
                "database": database,
            },
        })
        + ")\n"
    )

    def cli(args: list[str]) -> dict[str, Any]:
        result = runner.invoke(app, [*args, "--json"])
        assert result.exit_code == 0, format_test_diagnostic(" ".join(args), result)
        return dict(json.loads(result.stdout))

    def migrate(*flags: str) -> None:
        result = _retry(
            lambda: runner.invoke(app, ["migrate", "--execute", *flags, "--json"]),
            lambda r: r.exit_code == 0,
            attempts=3,
        )
        assert result.exit_code == 0, format_test_diagnostic("migrate", result)

    def drift() -> dict[str, Any]:
        return cli(["drift", "--live", "--table", full_name])

    def drift_until(ok: Callable[[dict[str, Any]], bool]) -> dict[str, Any]:
        payload = _retry(drift, ok)
        assert ok(payload), payload
        return payload

    def insert(values: str) -> None:
        client.command(f"INSERT INTO {full_name} (id, s, embedding) VALUES {values}")

    try:
        # 1. Create: drift reads it back clean, the CHECKs are enforced.
        schema_path.write_text(_render_schema(database, name, COLUMNS, [VECTOR, RAW], CONSTRAINTS))
        cli(["generate", "--name", "init"])
        migrate()
        drift_until(lambda p: p["drifted"] is False)
        insert("(1, 'a', [0.1, 0.2, 0.3, 0.4])")
        with pytest.raises(Exception, match="dimension"):
            insert("(2, 'a', [0.1, 0.2])")
        with pytest.raises(Exception, match="allowed"):
            insert("(3, 'c', [0.1, 0.2, 0.3, 0.4])")

        # 2. Pull: the live table renders back to a schema with no drift.
        with ClickHouseClient.connect(
            ChxResolvedClickHouseConfig(
                url=env.clickhouse_url,
                username=env.clickhouse_user,
                password=env.clickhouse_password,
                database=database,
                secure=env.clickhouse_url.startswith("https:"),
            )
        ) as chkit_client:
            live = poll_until(
                lambda: next(
                    (t for t in list_table_details(chkit_client, [database]) if t.name == name),
                    None,
                ),
                lambda t: t is not None and len(t.constraints or []) == len(CONSTRAINTS),
            )
        assert live is not None
        assert sorted(index.type for index in live.indexes) == ["raw", "vector_similarity"]
        assert TableConstraintDefinition(
            name="allowed", check="(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)"
        ) in (live.constraints or [])
        pulled = _introspected_table_to_definition(live)
        assert pulled is not None
        schema_path.write_text(render_schema_file([pulled]))
        drift_until(lambda p: p["drifted"] is False)
        schema_path.write_text(_render_schema(database, name, COLUMNS, [VECTOR, RAW], CONSTRAINTS))

        # 3. Out-of-band changes are drift, in both directions.
        client.command(f"ALTER TABLE {full_name} DROP CONSTRAINT dimension")
        client.command(f"ALTER TABLE {full_name} ADD CONSTRAINT extra CHECK id < 1000000")
        client.command(f"ALTER TABLE {full_name} DROP INDEX embedding_hnsw")
        out_of_band = drift_until(
            lambda p: bool(p["tableDrift"])
            and len(p["tableDrift"][0]["constraintDiffs"]) == 2
            and len(p["tableDrift"][0]["indexDiffs"]) == 1
        )
        detail = out_of_band["tableDrift"][0]
        assert detail["reasonCodes"] == ["index_mismatch", "constraint_mismatch"]
        assert detail["constraintDiffs"] == ["dimension", "extra"]
        assert detail["indexDiffs"] == ["embedding_hnsw"]
        client.command(f"ALTER TABLE {full_name} DROP CONSTRAINT extra")
        client.command(f"ALTER TABLE {full_name} ADD CONSTRAINT dimension CHECK length(embedding) = 4")
        client.command(
            f"ALTER TABLE {full_name} ADD INDEX embedding_hnsw embedding "
            "TYPE vector_similarity('hnsw', 'cosineDistance', 4) GRANULARITY 100000000"
        )
        drift_until(lambda p: p["drifted"] is False)

        # 4. Change: the changed index and CHECK are dropped and re-added.
        schema_path.write_text(
            _render_schema(database, name, COLUMNS, [CHANGED_VECTOR], CHANGED_CONSTRAINTS)
        )
        planned = cli(["generate", "--dryrun"])
        assert [op["type"] for op in planned["operations"]] == [
            "alter_table_drop_constraint",
            "alter_table_drop_constraint",
            "alter_table_drop_index",
            "alter_table_drop_index",
            "alter_table_add_constraint",
            "alter_table_add_constraint",
            "alter_table_add_index",
        ]
        cli(["generate", "--name", "change"])
        migrate()
        drift_until(lambda p: p["drifted"] is False)
        insert("(4, 'c', [0.1, 0.2, 0.3, 0.4])")

        # 5. Drop the column with the index and constraint that read it.
        schema_path.write_text(
            _render_schema(
                database, name, COLUMNS[:2], [], ["{'name': 'allowed', 'check': \"s IN ('a','b','c')\"}"]
            )
        )
        cli(["generate", "--name", "drop_embedding"])
        migrate("--allow-destructive")
        drift_until(lambda p: p["drifted"] is False)
    finally:
        client.command(f"DROP TABLE IF EXISTS {full_name} SYNC")
        client.command(f"DROP TABLE IF EXISTS {database}.{journal_table} SYNC")
