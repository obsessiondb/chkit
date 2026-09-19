"""Tests for `chkit.cli.logging_setup`."""

from __future__ import annotations

import logging

import pytest

from chkit.cli import logging_setup
from chkit.cli.logging_setup import (
    configure_cli_logging,
    debug,
    is_debug_enabled,
)


@pytest.fixture(autouse=True)
def _reset_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(logging_setup, "_CONFIGURED", False)
    logging.getLogger("chkit").handlers.clear()


def test_is_debug_enabled_false_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CHKIT_DEBUG", raising=False)
    assert is_debug_enabled() is False


def test_is_debug_enabled_for_1(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHKIT_DEBUG", "1")
    assert is_debug_enabled() is True


def test_is_debug_enabled_for_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHKIT_DEBUG", "true")
    assert is_debug_enabled() is True


def test_is_debug_enabled_rejects_other_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHKIT_DEBUG", "yes")
    assert is_debug_enabled() is False


def test_configure_attaches_handler_when_debug_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHKIT_DEBUG", "1")
    configure_cli_logging()
    logger = logging.getLogger("chkit")
    assert logger.level == logging.DEBUG
    assert len(logger.handlers) >= 1


def test_configure_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHKIT_DEBUG", "1")
    configure_cli_logging()
    handler_count = len(logging.getLogger("chkit").handlers)
    configure_cli_logging()
    assert len(logging.getLogger("chkit").handlers) == handler_count


def test_debug_writes_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("CHKIT_DEBUG", "1")
    debug("test", "hello", detail={"k": 1})
    captured = capsys.readouterr()
    # configure_cli_logging() writes to stderr via StreamHandler() default.
    assert "hello" in captured.err
    assert "'k': 1" in captured.err


def test_debug_silent_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv("CHKIT_DEBUG", raising=False)
    debug("test", "hello")
    assert capsys.readouterr().err == ""
