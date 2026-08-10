"""Tests for `chkit.core.plugin_error.wrap_plugin_run`."""

from __future__ import annotations

from typing import Any

import pytest

from chkit import wrap_plugin_run
from chkit.core.plugin_error import wrap_plugin_run as wrap_from_module


class _CapturedPrint:
    def __init__(self) -> None:
        self.calls: list[Any] = []

    def __call__(self, value: Any) -> None:
        self.calls.append(value)


def test_returns_fn_value_on_success() -> None:
    p = _CapturedPrint()
    result = wrap_plugin_run(
        command="schema",
        label="Pull schema",
        json_mode=False,
        print_=p,
        fn=lambda: 0,
    )
    assert result == 0
    assert p.calls == []


def test_returns_none_when_fn_returns_none() -> None:
    p = _CapturedPrint()
    result = wrap_plugin_run(
        command="schema",
        label="Pull schema",
        json_mode=False,
        print_=p,
        fn=lambda: None,
    )
    assert result is None
    assert p.calls == []


def test_text_mode_prints_label_failed_and_returns_1() -> None:
    p = _CapturedPrint()

    def boom() -> int | None:
        raise RuntimeError("connection refused")

    result = wrap_plugin_run(
        command="schema",
        label="Pull schema",
        json_mode=False,
        print_=p,
        fn=boom,
    )
    assert result == 1
    assert p.calls == ["Pull schema failed: connection refused"]


def test_json_mode_prints_envelope_and_returns_1() -> None:
    p = _CapturedPrint()

    def boom() -> int | None:
        raise RuntimeError("connection refused")

    result = wrap_plugin_run(
        command="schema",
        label="Pull schema",
        json_mode=True,
        print_=p,
        fn=boom,
    )
    assert result == 1
    assert p.calls == [
        {"ok": False, "command": "schema", "error": "connection refused"}
    ]


class _ConfigError(Exception):
    pass


def test_returns_2_when_error_matches_config_class_text_mode() -> None:
    p = _CapturedPrint()

    def boom() -> int | None:
        raise _ConfigError("missing api key")

    result = wrap_plugin_run(
        command="codegen",
        label="Codegen",
        json_mode=False,
        print_=p,
        fn=boom,
        config_error_class=_ConfigError,
    )
    assert result == 2
    assert p.calls == ["Codegen failed: missing api key"]


def test_returns_2_when_error_matches_config_class_json_mode() -> None:
    p = _CapturedPrint()

    def boom() -> int | None:
        raise _ConfigError("missing api key")

    result = wrap_plugin_run(
        command="codegen",
        label="Codegen",
        json_mode=True,
        print_=p,
        fn=boom,
        config_error_class=_ConfigError,
    )
    assert result == 2
    assert p.calls == [
        {"ok": False, "command": "codegen", "error": "missing api key"}
    ]


def test_returns_1_when_error_does_not_match_config_class() -> None:
    p = _CapturedPrint()

    def boom() -> int | None:
        raise RuntimeError("not a config error")

    result = wrap_plugin_run(
        command="codegen",
        label="Codegen",
        json_mode=False,
        print_=p,
        fn=boom,
        config_error_class=_ConfigError,
    )
    assert result == 1


def test_returns_1_when_no_config_class_supplied() -> None:
    p = _CapturedPrint()

    def boom() -> int | None:
        raise _ConfigError("looks like a config error")

    result = wrap_plugin_run(
        command="codegen",
        label="Codegen",
        json_mode=False,
        print_=p,
        fn=boom,
    )
    assert result == 1


def test_propagates_base_exception() -> None:
    p = _CapturedPrint()

    def boom() -> int | None:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        wrap_plugin_run(
            command="x",
            label="X",
            json_mode=False,
            print_=p,
            fn=boom,
        )


def test_reexport_from_top_level_matches_module() -> None:
    assert wrap_plugin_run is wrap_from_module


def test_text_error_handles_subclass_message() -> None:
    p = _CapturedPrint()

    class CustomError(Exception):
        def __str__(self) -> str:
            return "custom rendered"

    def boom() -> int | None:
        raise CustomError

    result = wrap_plugin_run(
        command="x",
        label="X",
        json_mode=False,
        print_=p,
        fn=boom,
    )
    assert result == 1
    assert p.calls == ["X failed: custom rendered"]
