"""``clickhouse.url`` sets the protocol and default port, like the TS client (#298).

``@clickhouse/client`` takes the protocol from the URL and, without a port,
dials the scheme's default (443 for https, 80 for http). ``secure`` can only
confirm the scheme; a contradicting value is a config error in both ports.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import clickhouse_connect  # type: ignore[import-untyped]
import pytest

from chkit.clickhouse import ClickHouseClient
from chkit.core.model import (
    ChxResolvedClickHouseConfig,
    ChxUserClickHouseConfig,
    ChxUserConfig,
    resolve_config,
)


def _resolve(url: str, secure: bool | None = None) -> ChxResolvedClickHouseConfig:
    ch = ChxUserClickHouseConfig(url=url, secure=secure)
    resolved = resolve_config(
        ChxUserConfig.model_validate({"schema": "s", "clickhouse": ch})
    ).clickhouse
    assert resolved is not None
    return resolved


def _connect_kwargs(
    url: str,
    monkeypatch: pytest.MonkeyPatch,
    created: list[SimpleNamespace] | None = None,
) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    def fake_get_client(**kwargs: Any) -> object:
        captured.update(kwargs)
        client = SimpleNamespace()
        if created is not None:
            created.append(client)
        return client

    monkeypatch.setattr(clickhouse_connect, "get_client", fake_get_client)
    ClickHouseClient.connect(_resolve(url))
    return captured


# ---------- resolve_config ----------


def test_https_url_without_secure_resolves_secure() -> None:
    assert _resolve("https://host").secure is True


def test_http_url_without_secure_resolves_insecure() -> None:
    assert _resolve("http://host").secure is False


def test_scheme_match_is_case_insensitive() -> None:
    assert _resolve("HTTPS://host:443").secure is True


def test_secure_that_agrees_with_the_scheme_is_accepted() -> None:
    assert _resolve("https://host", secure=True).secure is True
    assert _resolve("http://host:8123", secure=False).secure is False


def test_secure_true_with_http_url_is_rejected() -> None:
    with pytest.raises(
        ValueError, match=r"clickhouse\.secure is true but clickhouse\.url uses http://"
    ):
        _resolve("http://host", secure=True)


def test_secure_false_with_https_url_is_rejected() -> None:
    with pytest.raises(
        ValueError, match=r"clickhouse\.secure is false but clickhouse\.url uses https://"
    ):
        _resolve("https://host", secure=False)


# ---------- ClickHouseClient.connect ----------


def test_https_url_without_port_connects_securely_on_443(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kwargs = _connect_kwargs("https://host", monkeypatch)
    assert kwargs["host"] == "host"
    assert kwargs["port"] == 443
    assert kwargs["secure"] is True


def test_http_url_without_port_connects_on_80(monkeypatch: pytest.MonkeyPatch) -> None:
    kwargs = _connect_kwargs("http://host", monkeypatch)
    assert kwargs["port"] == 80
    assert kwargs["secure"] is False


def test_explicit_port_is_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    https = _connect_kwargs("https://host:8443", monkeypatch)
    assert https["port"] == 8443
    assert https["secure"] is True

    http = _connect_kwargs("http://localhost:8123", monkeypatch)
    assert http["port"] == 8123
    assert http["secure"] is False


def test_database_is_set_after_connecting(monkeypatch: pytest.MonkeyPatch) -> None:
    # The connect-time probes must not carry a database that may not exist yet (#351).
    created: list[SimpleNamespace] = []
    kwargs = _connect_kwargs("http://host", monkeypatch, created)
    assert "database" not in kwargs
    assert created[0].database == "default"


def test_url_without_http_scheme_is_rejected() -> None:
    config = ChxResolvedClickHouseConfig(
        url="tcp://host:9000", username="default", password="", database="default", secure=False
    )
    with pytest.raises(ValueError, match="protocol must be either http or https"):
        ClickHouseClient.connect(config)


def test_credentials_in_the_url_take_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    # As @clickhouse/client: each one the URL sets wins, percent-decoded.
    both = _connect_kwargs("http://al%40ice:SeC%40rEtPw@host", monkeypatch)
    assert (both["username"], both["password"]) == ("al@ice", "SeC@rEtPw")

    user_only = _connect_kwargs("http://alice@host", monkeypatch)
    assert (user_only["username"], user_only["password"]) == ("alice", "")

    neither = _connect_kwargs("http://host", monkeypatch)
    assert (neither["username"], neither["password"]) == ("default", "")


def test_invalid_url_errors_leave_out_credentials() -> None:
    for url, match in [
        ("ftp://u:SeCrEtPw@host", "Got: ftp:$"),
        ("http://u:SeCrEtPw@", r"missing host\): http://$"),
    ]:
        config = ChxResolvedClickHouseConfig(
            url=url, username="default", password="", database="default", secure=False
        )
        with pytest.raises(ValueError, match=match):
            ClickHouseClient.connect(config)
