"""Text and JSON output of ``chkit snapshot rebuild``.

1:1 port of ``packages/cli/src/commands/snapshot/output.ts``.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Final, Literal, TypeAlias

import typer

from chkit.cli.json_output import emit_json

PreviousSnapshotStatus: TypeAlias = Literal["missing", "parsed", "conflicted", "unreadable"]
UnreadableReason: TypeAlias = Literal["empty", "invalid_json", "invalid_shape"]
RebuildMode: TypeAlias = Literal["plan", "write"]

DOCS_URL: Final[str] = "https://chkit.obsessiondb.com/cli/snapshot/"

_UNREADABLE_LABELS: Final[dict[str, str]] = {
    "empty": "empty file",
    "invalid_json": "invalid JSON",
    "invalid_shape": "not a chkit snapshot",
}
# Text lines kept verbatim from the TS output (some exceed the line length).
_PLAN_REVIEW_INTRO: Final = "After the rebuild, compare snapshot.json with both sides of the conflict before you commit it:"  # noqa: E501
_WRITE_REVIEW_INTRO: Final = "Compare snapshot.json with both sides of the conflict before you commit it:"  # noqa: E501
_REVIEW_RULE: Final = "Every entry that differs from one side must come from a migration file of the other side."  # noqa: E501
_RESTORE_INTRO: Final = (
    "If no merge or rebase is in progress and the damaged file is committed, its committed version",
    "is a safer baseline than a rebuild. Restore it with:",
)
_CAUTION_BODY: Final = (
    "`chkit generate` will not write a migration for any change it absorbed. Rebuild only when",
    "every schema change already has a migration file. For merged branches, `chkit generate --dryrun`",  # noqa: E501
    "should have reported 0 operations on each branch. After upgrading chkit, run `chkit generate` first.",  # noqa: E501
)
_SHELL_SAFE_PATH: Final[re.Pattern[str]] = re.compile(r"^[\w./-]+$", re.ASCII)


@dataclass(frozen=True, slots=True)
class PreviousSnapshotReport:
    """What ``snapshot rebuild`` found in the existing snapshot.json before rewriting it."""

    status: PreviousSnapshotStatus
    reason: UnreadableReason | None = None
    added: list[str] = field(default_factory=list[str])
    removed: list[str] = field(default_factory=list[str])
    changed: list[str] = field(default_factory=list[str])

    def to_payload(self) -> dict[str, Any]:
        if self.status == "parsed":
            return {
                "status": "parsed",
                "added": list(self.added),
                "removed": list(self.removed),
                "changed": list(self.changed),
            }
        if self.status == "unreadable":
            return {"status": "unreadable", "reason": self.reason}
        return {"status": self.status}

    @property
    def change_count(self) -> int:
        return len(self.added) + len(self.removed) + len(self.changed)


@dataclass(frozen=True, slots=True)
class SnapshotRebuildPayload:
    mode: RebuildMode
    snapshot_file: str
    written: bool
    definition_count: int
    previous: PreviousSnapshotReport

    def to_payload(self) -> dict[str, Any]:
        return {
            "subcommand": "rebuild",
            "mode": self.mode,
            "snapshotFile": self.snapshot_file,
            "written": self.written,
            "definitionCount": self.definition_count,
            "previous": self.previous.to_payload(),
        }


def emit_snapshot_rebuild_output(payload: SnapshotRebuildPayload, *, json_mode: bool) -> None:
    if json_mode:
        emit_json("snapshot", payload.to_payload())
        return
    typer.echo("\n".join(format_snapshot_rebuild_text(payload)))


def format_snapshot_rebuild_text(payload: SnapshotRebuildPayload) -> list[str]:
    previous = payload.previous
    display_path = _format_shell_path(payload.snapshot_file)
    lines = [
        _format_header(payload),
        f"Definitions:        {payload.definition_count}",
        f"Previous snapshot:  {_format_previous_summary(previous)}",
    ]

    if previous.status == "parsed":
        lines.extend(f"  + {key}" for key in previous.added)
        lines.extend(f"  - {key}" for key in previous.removed)
        lines.extend(f"  ~ {key}" for key in previous.changed)

    if previous.status == "conflicted":
        # Only one of MERGE_HEAD and REBASE_HEAD exists at a time, so each gets its
        # own line. The labels are shell comments: a line still runs when pasted.
        lines.extend(
            [
                "",
                _PLAN_REVIEW_INTRO if payload.mode == "plan" else _WRITE_REVIEW_INTRO,
                f"  git diff HEAD -- {display_path}",
                f"  git diff MERGE_HEAD -- {display_path}    # during a merge",
                f"  git diff REBASE_HEAD -- {display_path}   # during a rebase",
                _REVIEW_RULE,
            ]
        )

    if previous.status == "unreadable":
        # `git checkout -- <path>` restores from the index, which still holds a
        # staged damaged file and refuses an unmerged one. HEAD is the committed
        # version, but during a merge or rebase it is only one side of the conflict.
        lines.extend(
            [
                "",
                *_RESTORE_INTRO,
                f"  git checkout HEAD -- {display_path}",
            ]
        )

    if _needs_caution(previous):
        lines.extend(["", *_format_caution(payload.mode)])

    return lines


def _format_header(payload: SnapshotRebuildPayload) -> str:
    if payload.mode == "plan":
        return f"Dry run: {payload.snapshot_file} was not written."
    if payload.written and payload.previous.status == "missing":
        return f"Created snapshot: {payload.snapshot_file}"
    if payload.written:
        return f"Rebuilt snapshot: {payload.snapshot_file}"
    return f"Snapshot is up to date: {payload.snapshot_file}"


def _format_previous_summary(previous: PreviousSnapshotReport) -> str:
    if previous.status == "missing":
        return "none"
    if previous.status == "parsed":
        return (
            f"{len(previous.added)} added, {len(previous.removed)} removed, "
            f"{len(previous.changed)} changed"
        )
    if previous.status == "conflicted":
        return "unresolved merge conflict markers (not compared)"
    label = _UNREADABLE_LABELS.get(previous.reason or "", previous.reason or "")
    return f"{label} (not compared)"


def _format_shell_path(file: str) -> str:
    """The snapshot path for a copy-pasteable command: relative when it is inside
    cwd, quoted when needed."""
    try:
        from_cwd = os.path.relpath(file, os.getcwd())
    except ValueError:  # different drives on Windows
        from_cwd = ""
    inside = from_cwd not in ("", ".") and not from_cwd.startswith("..")
    path = from_cwd if inside and not os.path.isabs(from_cwd) else file
    if _SHELL_SAFE_PATH.match(path):
        return path
    escaped = path.replace("'", "'\\''")
    return f"'{escaped}'"


def _needs_caution(previous: PreviousSnapshotReport) -> bool:
    if previous.status != "parsed":
        return True
    return previous.change_count > 0


def _format_caution(mode: RebuildMode) -> list[str]:
    verb = "would record" if mode == "plan" else "records"
    return [
        f"Caution: the rebuilt snapshot {verb} every schema definition as already migrated, so",
        *_CAUTION_BODY,
        f"When not to rebuild: {DOCS_URL}#when-not-to-rebuild",
    ]
