"""Tests for `chkit.cli.json_output`."""

from __future__ import annotations

import json

import pytest

from chkit.cli.json_output import (
    JSON_CONTRACT_VERSION,
    _reset_for_testing,
    build_json_error_envelope,
    emit_json,
    emit_json_error,
    has_emitted_json,
    print_output,
)


@pytest.fixture(autouse=True)
def _reset_emitted() -> None:
    _reset_for_testing()


def test_emit_json_wraps_with_command_and_version(capsys: pytest.CaptureFixture[str]) -> None:
    emit_json("status", {"pending": 3})
    out = capsys.readouterr().out
    decoded = json.loads(out)
    assert decoded["command"] == "status"
    assert decoded["schemaVersion"] == JSON_CONTRACT_VERSION
    assert decoded["pending"] == 3


def test_emit_json_marks_emitted(capsys: pytest.CaptureFixture[str]) -> None:
    assert has_emitted_json() is False
    emit_json("status", {"x": 1})
    capsys.readouterr()
    assert has_emitted_json() is True


def test_print_output_wraps_bare_string_under_json(
    capsys: pytest.CaptureFixture[str],
) -> None:
    print_output("hello", json_mode=True)
    out = capsys.readouterr().out
    decoded = json.loads(out)
    assert decoded == {"schemaVersion": JSON_CONTRACT_VERSION, "message": "hello"}


def test_print_output_passes_dicts_through_under_json(
    capsys: pytest.CaptureFixture[str],
) -> None:
    print_output({"foo": "bar"}, json_mode=True)
    decoded = json.loads(capsys.readouterr().out)
    assert decoded == {"foo": "bar"}


def test_print_output_writes_string_directly_in_text_mode(
    capsys: pytest.CaptureFixture[str],
) -> None:
    print_output("hello", json_mode=False)
    assert capsys.readouterr().out == "hello\n"


def test_print_output_drops_non_string_in_text_mode(
    capsys: pytest.CaptureFixture[str],
) -> None:
    print_output({"foo": "bar"}, json_mode=False)
    assert capsys.readouterr().out == ""


def test_build_json_error_envelope_shape() -> None:
    envelope = build_json_error_envelope(
        "migrate", {"code": "boom", "message": "kaboom", "hint": "try again"}
    )
    assert envelope["command"] == "migrate"
    assert envelope["schemaVersion"] == JSON_CONTRACT_VERSION
    assert envelope["ok"] is False
    assert envelope["error"]["code"] == "boom"


def test_emit_json_error_writes_envelope_to_stdout(
    capsys: pytest.CaptureFixture[str],
) -> None:
    emit_json_error("status", {"code": "x", "message": "y"})
    out = json.loads(capsys.readouterr().out)
    assert out == {
        "command": "status",
        "schemaVersion": JSON_CONTRACT_VERSION,
        "ok": False,
        "error": {"code": "x", "message": "y"},
    }
    assert has_emitted_json() is True
