import json
from pathlib import Path

import pytest

from chkit.cli.data_copy_warnings import collect_data_copy_warnings

CASES = json.loads(
    (
        Path(__file__).resolve().parents[2] / "test/fixtures/migration-data-copy-warnings.json"
    ).read_text()
)


@pytest.mark.parametrize("case", CASES, ids=[case["sql"] for case in CASES])
def test_data_copy_warning(case: dict[str, str | int]) -> None:
    warnings = collect_data_copy_warnings(str(case["sql"]), "manual.sql")
    assert len(warnings) == case["count"]
    for warning in warnings:
        assert "manual.sql, statement " in warning
        assert "small copies in migrations are acceptable" in warning


def test_generated_assertion() -> None:
    assert (
        collect_data_copy_warnings("SELECT count() FROM dst", "table:dst", "assert_backfill") == []
    )
