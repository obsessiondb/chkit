"""Tests for `chkit.cli.commands.migrate_prompts`."""

from __future__ import annotations

import io
import sys
from collections.abc import Iterator
from typing import Any

import pytest

from chkit.cli.commands.migrate_prompts import (
    confirm_apply,
    is_background_or_ci,
)


@pytest.fixture
def clean_ci_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.delenv("CI", raising=False)
    return


# ---------- is_background_or_ci ----------


class _FakeStream:
    def __init__(self, *, isatty: bool) -> None:
        self._isatty = isatty

    def isatty(self) -> bool:
        return self._isatty


def _stub_streams(
    monkeypatch: pytest.MonkeyPatch, *, stdin_tty: bool, stdout_tty: bool
) -> None:
    monkeypatch.setattr(sys, "stdin", _FakeStream(isatty=stdin_tty))
    monkeypatch.setattr(sys, "stdout", _FakeStream(isatty=stdout_tty))


def test_returns_true_when_ci_env_is_1(
    monkeypatch: pytest.MonkeyPatch, clean_ci_env: None
) -> None:
    monkeypatch.setenv("CI", "1")
    _stub_streams(monkeypatch, stdin_tty=True, stdout_tty=True)
    assert is_background_or_ci() is True


def test_returns_true_when_ci_env_is_true(
    monkeypatch: pytest.MonkeyPatch, clean_ci_env: None
) -> None:
    monkeypatch.setenv("CI", "true")
    _stub_streams(monkeypatch, stdin_tty=True, stdout_tty=True)
    assert is_background_or_ci() is True


def test_returns_true_when_stdin_not_tty(
    monkeypatch: pytest.MonkeyPatch, clean_ci_env: None
) -> None:
    _stub_streams(monkeypatch, stdin_tty=False, stdout_tty=True)
    assert is_background_or_ci() is True


def test_returns_true_when_stdout_not_tty(
    monkeypatch: pytest.MonkeyPatch, clean_ci_env: None
) -> None:
    _stub_streams(monkeypatch, stdin_tty=True, stdout_tty=False)
    assert is_background_or_ci() is True


def test_returns_false_when_interactive_and_no_ci(
    monkeypatch: pytest.MonkeyPatch, clean_ci_env: None
) -> None:
    _stub_streams(monkeypatch, stdin_tty=True, stdout_tty=True)
    assert is_background_or_ci() is False


def test_ci_env_other_values_do_not_trigger(
    monkeypatch: pytest.MonkeyPatch, clean_ci_env: None
) -> None:
    monkeypatch.setenv("CI", "yes")
    _stub_streams(monkeypatch, stdin_tty=True, stdout_tty=True)
    # TS only matches "1" or "true" exactly.
    assert is_background_or_ci() is False


# ---------- confirm_apply ----------


@pytest.fixture
def captured_stdout(monkeypatch: pytest.MonkeyPatch) -> Iterator[io.StringIO]:
    buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buf)
    return buf


def _patch_input(monkeypatch: pytest.MonkeyPatch, response: str) -> None:
    monkeypatch.setattr("builtins.input", lambda _prompt="": response)


def test_confirm_apply_returns_true_for_yes(
    monkeypatch: pytest.MonkeyPatch, captured_stdout: io.StringIO
) -> None:
    _patch_input(monkeypatch, "yes")
    assert confirm_apply() is True


def test_confirm_apply_returns_true_for_yes_mixed_case(
    monkeypatch: pytest.MonkeyPatch, captured_stdout: io.StringIO
) -> None:
    _patch_input(monkeypatch, "Yes")
    assert confirm_apply() is True


def test_confirm_apply_returns_true_for_yes_with_whitespace(
    monkeypatch: pytest.MonkeyPatch, captured_stdout: io.StringIO
) -> None:
    _patch_input(monkeypatch, "  yes  ")
    assert confirm_apply() is True


def test_confirm_apply_returns_false_for_no(
    monkeypatch: pytest.MonkeyPatch, captured_stdout: io.StringIO
) -> None:
    _patch_input(monkeypatch, "no")
    assert confirm_apply() is False


def test_confirm_apply_returns_false_for_empty(
    monkeypatch: pytest.MonkeyPatch, captured_stdout: io.StringIO
) -> None:
    _patch_input(monkeypatch, "")
    assert confirm_apply() is False


def test_confirm_apply_returns_false_for_other_text(
    monkeypatch: pytest.MonkeyPatch, captured_stdout: io.StringIO
) -> None:
    _patch_input(monkeypatch, "maybe")
    assert confirm_apply() is False


def test_confirm_apply_returns_false_on_eof(
    monkeypatch: pytest.MonkeyPatch, captured_stdout: io.StringIO
) -> None:
    def _raise(_prompt: str = "") -> Any:
        raise EOFError

    monkeypatch.setattr("builtins.input", _raise)
    assert confirm_apply() is False


def test_confirm_apply_prints_instructions(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _patch_input(monkeypatch, "yes")
    confirm_apply()
    out = capsys.readouterr().out
    assert 'Type "yes" to continue.' in out
