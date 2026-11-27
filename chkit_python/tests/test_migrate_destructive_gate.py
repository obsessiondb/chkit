"""Destructive gate messages match the TS CLI line for line (#889)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import typer

from chkit.cli.commands import migrate


def _ctx(migrations_dir: Path) -> Any:
    return SimpleNamespace(
        migrations_dir=migrations_dir,
        allow_destructive=False,
        config=SimpleNamespace(safety=SimpleNamespace(allow_destructive=False)),
        json_mode=False,
    )


def _write_destructive(tmp_path: Path) -> str:
    name = "20260101000000_drop.sql"
    (tmp_path / name).write_text("DROP TABLE app.events;\n", encoding="utf-8")
    return name


def test_declined_prompt_prints_the_two_ts_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    name = _write_destructive(tmp_path)
    monkeypatch.setattr(migrate, "is_background_or_ci", lambda: False)
    monkeypatch.setattr(migrate, "confirm_destructive_execution", lambda _markers: False)

    with pytest.raises(typer.Exit) as exit_info:
        migrate._run_destructive_gate(_ctx(tmp_path), [name])

    assert exit_info.value.exit_code == 3
    assert capsys.readouterr().err.splitlines() == [
        "Destructive migration cancelled by user.",
        f"Destructive migrations: {name}",
    ]


def test_non_interactive_refusal_prints_the_three_ts_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    name = _write_destructive(tmp_path)
    monkeypatch.setattr(migrate, "is_background_or_ci", lambda: True)

    with pytest.raises(typer.Exit) as exit_info:
        migrate._run_destructive_gate(_ctx(tmp_path), [name])

    assert exit_info.value.exit_code == 3
    assert capsys.readouterr().err.splitlines() == [
        "Blocked destructive migration execution. Re-run with --allow-destructive "
        "or set safety.allowDestructive=true after review.",
        f"Destructive migrations: {name}",
        "Non-interactive run detected. Pass --allow-destructive to proceed.",
    ]
