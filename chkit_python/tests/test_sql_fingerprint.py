"""Statement fingerprints are the same as TS (#599).

``test/fixtures/statement-fingerprint.json`` is shared with
``packages/core/src/sql-fingerprint.test.ts``: both ports must give the same
values.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from chkit.core.sql_fingerprint import statement_fingerprint

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/statement-fingerprint.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["name"])
def test_fixture_value(case: dict[str, str]) -> None:
    assert statement_fingerprint(case["sql"]) == case["fingerprint"]


@pytest.mark.parametrize("group", FIXTURE["same"], ids=lambda group: group["name"])
def test_same_fingerprint(group: dict[str, Any]) -> None:
    assert len({statement_fingerprint(sql) for sql in group["sql"]}) == 1


@pytest.mark.parametrize("group", FIXTURE["different"], ids=lambda group: group["name"])
def test_different_fingerprints(group: dict[str, Any]) -> None:
    assert len({statement_fingerprint(sql) for sql in group["sql"]}) == len(group["sql"])
