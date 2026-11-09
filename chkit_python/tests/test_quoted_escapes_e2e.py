"""Port of ``packages/clickhouse/src/quoted-escapes.e2e.test.ts`` (#639).

The server reads every name and string in ``test/fixtures/quoted-escapes.json``
as the fixture says, so the lexer tests that share it (both ports) hold
against ClickHouse itself.
"""

from __future__ import annotations

import json
from pathlib import Path

import clickhouse_connect  # type: ignore[import-untyped]

from tests.e2e_testkit import live_env_to_client_kwargs, resolve_live_env

CASES: list[dict[str, str]] = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/quoted-escapes.json").read_text(
        encoding="utf-8"
    )
)["cases"]


def test_clickhouse_reads_the_escapes_in_quoted_names_and_strings_as_the_shared_fixture_says() -> None:
    client = clickhouse_connect.get_client(**live_env_to_client_kwargs(resolve_live_env()))
    read = []
    for case in CASES:
        sql = case["sql"]
        query = f"SELECT {sql} AS v" if sql.startswith("'") else f"DESCRIBE (SELECT 1 AS {sql})"
        # JSON over raw bytes, read as UTF-8 the way the TS client reads them,
        # so a name that is not valid UTF-8 compares as U+FFFD in both ports.
        raw = client.raw_query(query, fmt="JSONEachRow").decode("utf-8", "replace")
        row = json.loads(raw.splitlines()[0])
        read.append({"sql": sql, "value": row["v" if sql.startswith("'") else "name"]})
    client.close()
    assert read == [{"sql": case["sql"], "value": case["value"]} for case in CASES]
