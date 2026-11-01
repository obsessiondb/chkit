"""`drift --live` prints the same JSON and text as the TS command (#410).

The expected values follow ``packages/cli/src/commands/drift/command.ts``:
camelCase keys, unset object drift fields left out (not null), and the TS
text sections.
"""

from __future__ import annotations

import json
from contextlib import nullcontext
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands import drift
from chkit.cli.commands.drift_compare import KindMismatch, ObjectDriftDetail, TableDriftDetail
from chkit.cli.commands.drift_payload import DriftPayload
from chkit.cli.main import app

CONFIG = """
from chkit import define_config

config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": {
            "url": "http://localhost:8123",
            "username": "default",
            "password": "",
            "database": "app",
        },
    }
)
"""

TABLE_DRIFT = TableDriftDetail(
    table="app.events",
    reason_codes=["missing_column", "engine_mismatch"],
    missing_columns=["a", "b"],
    extra_columns=[],
    changed_columns=[],
    setting_diffs=[],
    index_diffs=[],
    ttl_mismatch=False,
    engine_mismatch=True,
    primary_key_mismatch=False,
    order_by_mismatch=False,
    unique_key_mismatch=False,
    partition_by_mismatch=False,
    projection_diffs=[],
    constraint_diffs=[],
)


def _payload(snapshot_file: str, *, database_missing: bool = False) -> DriftPayload:
    return DriftPayload(
        snapshot_file=snapshot_file,
        expected_count=4,
        actual_count=4,
        drifted=True,
        missing=["table:app.gone"],
        extra=["view:app.stray"],
        kind_mismatches=[KindMismatch(object="app.kind", expected="table", actual="view")],
        object_drift=[
            ObjectDriftDetail(
                code="kind_mismatch", object="app.kind", expected_kind="table", actual_kind="view"
            ),
            ObjectDriftDetail(code="missing_object", object="table:app.gone", expected_kind="table"),
            ObjectDriftDetail(code="extra_object", object="view:app.stray", actual_kind="view"),
            ObjectDriftDetail(
                code="query_mismatch", object="app.v", expected="SELECT 1", actual="SELECT 2"
            ),
        ],
        table_drift=[TABLE_DRIFT],
        database_missing=database_missing,
        database="app" if database_missing else None,
    )


def _invoke(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, args: list[str], **payload_kwargs: Any
) -> Any:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG, encoding="utf-8")
    (tmp_path / "schema.py").write_text("definitions = []\n", encoding="utf-8")
    assert CliRunner().invoke(app, ["generate"]).exit_code == 0
    snapshot_file = str(tmp_path / "chkit" / "meta" / "snapshot.json")
    monkeypatch.setattr(drift, "open_client", lambda *_args: nullcontext(None))
    monkeypatch.setattr(
        drift, "build_drift_payload", lambda **_kwargs: _payload(snapshot_file, **payload_kwargs)
    )
    result = CliRunner().invoke(app, ["drift", "--live", *args])
    assert result.exit_code == 0, result.output
    return result


def test_json_matches_the_ts_payload(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    result = _invoke(tmp_path, monkeypatch, ["--json"])

    payload = json.loads(result.stdout)
    assert list(payload) == [
        "command", "schemaVersion", "scope", "snapshotFile", "expectedCount", "actualCount",
        "drifted", "missing", "extra", "kindMismatches", "objectDrift", "tableDrift",
    ]
    assert payload["scope"] == {"enabled": False, "matchedTables": [], "matchCount": 0}
    assert payload["snapshotFile"] == str(tmp_path / "chkit" / "meta" / "snapshot.json")
    assert payload["kindMismatches"] == [{"object": "app.kind", "expected": "table", "actual": "view"}]
    assert payload["objectDrift"] == [
        {"code": "kind_mismatch", "object": "app.kind", "expectedKind": "table", "actualKind": "view"},
        {"code": "missing_object", "object": "table:app.gone", "expectedKind": "table"},
        {"code": "extra_object", "object": "view:app.stray", "actualKind": "view"},
        {"code": "query_mismatch", "object": "app.v", "expected": "SELECT 1", "actual": "SELECT 2"},
    ]
    assert list(payload["tableDrift"][0]) == [
        "table", "reasonCodes", "missingColumns", "extraColumns", "changedColumns",
        "settingDiffs", "indexDiffs", "ttlMismatch", "engineMismatch", "primaryKeyMismatch",
        "orderByMismatch", "uniqueKeyMismatch", "partitionByMismatch", "projectionDiffs",
        "constraintDiffs",
    ]
    assert payload["tableDrift"][0]["missingColumns"] == ["a", "b"]


def test_json_puts_database_missing_after_drifted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = _invoke(tmp_path, monkeypatch, ["--json"], database_missing=True)

    keys = list(json.loads(result.stdout))
    assert keys[keys.index("drifted") + 1 : keys.index("missing")] == ["databaseMissing", "database"]


def test_text_matches_the_ts_sections(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    result = _invoke(tmp_path, monkeypatch, [], database_missing=True)

    assert result.stdout == (
        '⚠ Database "app" does not exist on the target server.\n'
        "  It will be created when you run: chkit migrate --apply\n"
        "\n"
        "Expected objects: 4\n"
        "Actual objects:   4\n"
        "Drifted:          yes\n"
        "\n"
        "Missing objects:\n"
        "- table:app.gone\n"
        "\n"
        "Unexpected objects:\n"
        "- view:app.stray\n"
        "\n"
        "Kind mismatches:\n"
        "- app.kind: expected=table actual=view\n"
        "\n"
        "Object drift reasons:\n"
        "- kind_mismatch app.kind: expected=table actual=view\n"
        "- missing_object table:app.gone\n"
        "- extra_object view:app.stray\n"
        "- query_mismatch app.v\n"
        "  expected=SELECT 1\n"
        "  actual=SELECT 2\n"
        "\n"
        "Table shape drift:\n"
        "- app.events\n"
        "  missingColumns=a,b\n"
        "  engineMismatch=true\n"
        "  reasonCodes=missing_column,engine_mismatch\n"
    )


def test_selector_without_matches_is_a_no_op(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    text = _invoke(tmp_path, monkeypatch, ["--table", "nope"])
    assert text.stdout == 'No tables matched selector "nope". Drift check is a no-op.\n'

    payload = json.loads(_invoke(tmp_path, monkeypatch, ["--table", "nope", "--json"]).stdout)
    assert payload["scope"] == {
        "enabled": True, "selector": "nope", "matchedTables": [], "matchCount": 0,
    }
    assert payload["drifted"] is False
    assert payload["objectDrift"] == []
    assert payload["warning"] == 'No tables matched selector "nope".'
