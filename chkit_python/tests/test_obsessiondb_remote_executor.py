"""_raise_if_error keeps the ClickHouse exception code on the raised error."""

from __future__ import annotations

import pytest

from chkit_plugin_obsessiondb.remote_executor import _raise_if_error
from chkit_plugin_obsessiondb.workbench_api import WorkbenchExecuteResult


def _result(error: str | None) -> WorkbenchExecuteResult:
    return WorkbenchExecuteResult(data=[], meta=[], rows=0, error=error)


def test_raise_if_error_keeps_the_clickhouse_code() -> None:
    # #671: the console relays ClickHouse's error text; the raised error keeps
    # the exception code so async migrate can tell a server rejection from a
    # transport failure.
    with pytest.raises(RuntimeError, match="Syntax error") as excinfo:
        _raise_if_error(
            _result("Code: 62. DB::Exception: Syntax error: failed at position 1")
        )
    assert excinfo.value.code == "62"  # type: ignore[attr-defined]


def test_raise_if_error_without_code_stays_plain() -> None:
    with pytest.raises(RuntimeError, match="gateway timeout") as excinfo:
        _raise_if_error(_result("HTTP 524: gateway timeout"))
    assert getattr(excinfo.value, "code", None) is None


def test_raise_if_error_drops_relayed_network_codes() -> None:
    # Relayed client-side network codes are transport failures, not rejections:
    # they must not land on the error as a ClickHouse exception code (#671 review).
    for relayed in (
        "Code: 209. DB::NetException: Timeout: connect timed out (SOCKET_TIMEOUT)",
        "Code: 210. DB::NetException: Network error (NETWORK_ERROR)",
    ):
        with pytest.raises(RuntimeError) as excinfo:
            _raise_if_error(_result(relayed))
        assert getattr(excinfo.value, "code", None) is None


def test_raise_if_error_passes_a_clean_result() -> None:
    _raise_if_error(_result(None))
