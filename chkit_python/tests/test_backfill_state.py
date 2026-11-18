"""Port of ``packages/plugin-backfill/src/state.test.ts``."""

from __future__ import annotations

import json
from pathlib import Path

from chkit_plugin_backfill.state import write_json


def test_write_json_replaces_the_file_and_leaves_no_temporary_file(
    tmp_path: Path,
) -> None:
    run_path = tmp_path / "runs" / "plan.json"

    write_json(run_path, {"progress": {"c1": {"status": "pending", "queryId": "q-1"}}})
    first = run_path.stat()
    write_json(run_path, {"progress": {"c1": {"status": "submitted", "queryId": "q-1"}}})
    second = run_path.stat()

    # A truncating write keeps the inode; a rename gives the path a new one,
    # so a crash mid-write leaves the previous checkpoint whole (#765).
    assert second.st_ino != first.st_ino
    assert json.loads(run_path.read_text(encoding="utf-8")) == {
        "progress": {"c1": {"status": "submitted", "queryId": "q-1"}}
    }
    assert [entry.name for entry in (tmp_path / "runs").iterdir()] == ["plan.json"]
