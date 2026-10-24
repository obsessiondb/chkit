"""``clickhouse.url`` scheme decides the protocol when ``secure`` is unset (#298).

The TS client takes the protocol from the URL, so ``"url": "https://host"``
must connect over HTTPS without a ``secure`` key. An explicit ``secure`` wins.
"""

from __future__ import annotations

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
    config: ChxResolvedClickHouseConfig, monkeypatch: pytest.MonkeyPatch
) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    def fake_get_client(**kwargs: Any) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(clickhouse_connect, "get_client", fake_get_client)
    ClickHouseClient.connect(config)
    return captured


def test_https_url_without_secure_resolves_secure() -> None:
    assert _resolve("https://host").secure is True


def test_http_url_without_secure_resolves_insecure() -> None:
    assert _resolve("http://host").secure is False


def test_scheme_match_is_case_insensitive() -> None:
    assert _resolve("HTTPS://host").secure is True


def test_explicit_secure_false_wins_over_https_url() -> None:
    assert _resolve("https://host", secure=False).secure is False


def test_explicit_secure_true_wins_over_http_url() -> None:
    assert _resolve("http://host", secure=True).secure is True


def test_https_url_without_port_connects_securely_on_8443(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kwargs = _connect_kwargs(_resolve("https://host"), monkeypatch)
    assert kwargs["host"] == "host"
    assert kwargs["port"] == 8443
    assert kwargs["secure"] is True


def test_http_url_without_port_connects_on_8123(monkeypatch: pytest.MonkeyPatch) -> None:
    kwargs = _connect_kwargs(_resolve("http://host"), monkeypatch)
    assert kwargs["port"] == 8123
    assert kwargs["secure"] is False


def test_explicit_port_is_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    kwargs = _connect_kwargs(_resolve("https://host:443"), monkeypatch)
    assert kwargs["port"] == 443
    assert kwargs["secure"] is True


def test_explicit_secure_false_with_https_url_connects_over_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kwargs = _connect_kwargs(_resolve("https://host", secure=False), monkeypatch)
    assert kwargs["port"] == 8123
    assert kwargs["secure"] is False
