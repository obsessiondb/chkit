"""Port of ``packages/plugin-backfill/src/state.test.ts``."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

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


# #765: a rename alone can be lost on power loss, bringing back the checkpoint
# without the replay's query id.
def test_write_json_syncs_the_temporary_file_before_the_rename_and_the_directory_after(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_path = tmp_path / "runs" / "plan.json"
    write_json(run_path, {"progress": {"c1": {"status": "failed"}}})
    # What the checkpoint holds at each sync: the old state at the temporary
    # file's sync, the new one once the rename is done.
    seen_at_sync: list[str] = []

    def record_sync(_fd: int) -> None:
        seen_at_sync.append(json.loads(run_path.read_text(encoding="utf-8"))["progress"]["c1"]["status"])

    monkeypatch.setattr("chkit_plugin_backfill.state.os.fsync", record_sync)

    write_json(run_path, {"progress": {"c1": {"status": "pending", "queryId": "q-2"}}})

    assert seen_at_sync == ["failed", "pending"]


# Round 2: a new runs/ is an entry in the state directory; until that
# directory is synced, a power loss can drop runs/ with the checkpoint.
def test_write_json_syncs_the_parent_of_each_directory_it_creates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    synced: list[int] = []
    real_fsync = os.fsync

    def record_sync(fd: int) -> None:
        synced.append(os.fstat(fd).st_ino)
        real_fsync(fd)

    monkeypatch.setattr("chkit_plugin_backfill.state.os.fsync", record_sync)

    write_json(tmp_path / "runs" / "nested" / "plan.json", {"progress": {}})

    assert tmp_path.stat().st_ino in synced
    assert (tmp_path / "runs").stat().st_ino in synced
