"""Unit tests for :mod:`tests.e2e_testkit` — the shared e2e helper primitives."""

from __future__ import annotations

import pytest

from tests.e2e_testkit import (
    LOCAL_STACK_ENV,
    LiveEnv,
    get_required_env,
    live_env_to_client_kwargs,
    resolve_live_env,
)

# ---------- get_required_env (hard-fail variant) ----------


def test_get_required_env_hard_fails_when_url_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("CLICKHOUSE_URL", "CLICKHOUSE_HOST", "CLICKHOUSE_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(RuntimeError, match="Missing CLICKHOUSE_URL"):
        get_required_env()


def test_get_required_env_hard_fails_when_password_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLICKHOUSE_URL", "https://ch.example:8443")
    monkeypatch.delenv("CLICKHOUSE_PASSWORD", raising=False)
    with pytest.raises(RuntimeError, match="Missing CLICKHOUSE_PASSWORD"):
        get_required_env()


def test_get_required_env_derives_url_from_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_DB"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CLICKHOUSE_HOST", "ch.example.com")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "s3cret")
    env = get_required_env()
    assert env.clickhouse_url == "https://ch.example.com"
    assert env.clickhouse_password == "s3cret"
    assert env.clickhouse_user == "default"  # implicit default
    assert env.clickhouse_database == "default"  # implicit default


def test_get_required_env_returns_all_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLICKHOUSE_URL", "https://ch.example:8443")
    monkeypatch.setenv("CLICKHOUSE_USER", "lucas")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "s3cret")
    monkeypatch.setenv("CLICKHOUSE_DB", "analytics")
    env = get_required_env()
    assert env == LiveEnv(
        clickhouse_url="https://ch.example:8443",
        clickhouse_user="lucas",
        clickhouse_password="s3cret",
        clickhouse_database="analytics",
    )


# ---------- resolve_live_env (TS getLiveEnv) ----------


def _clear_clickhouse_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("CLICKHOUSE_URL", "CLICKHOUSE_HOST", "CLICKHOUSE_USER",
                 "CLICKHOUSE_PASSWORD", "CLICKHOUSE_DB"):
        monkeypatch.delenv(name, raising=False)


def test_resolve_live_env_defaults_to_local_test_stack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_clickhouse_env(monkeypatch)
    env = resolve_live_env()
    assert env == LOCAL_STACK_ENV
    assert env.clickhouse_user == "default"
    assert env.clickhouse_password == "chkit-ci"
    assert env.clickhouse_database == "default"


def test_resolve_live_env_ignores_password_without_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_clickhouse_env(monkeypatch)
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "other")
    assert resolve_live_env() == LOCAL_STACK_ENV


def test_resolve_live_env_env_overrides_win(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_clickhouse_env(monkeypatch)
    monkeypatch.setenv("CLICKHOUSE_URL", "https://custom:9000")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pw")
    env = resolve_live_env()
    assert env.clickhouse_url == "https://custom:9000"
    assert env.clickhouse_password == "pw"


def test_resolve_live_env_remote_target_requires_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_clickhouse_env(monkeypatch)
    monkeypatch.setenv("CLICKHOUSE_HOST", "example.invalid")
    with pytest.raises(RuntimeError, match="CLICKHOUSE_PASSWORD"):
        resolve_live_env()


# ---------- live_env_to_client_kwargs ----------


def test_live_env_to_client_kwargs_parses_https_default_port() -> None:
    env = LiveEnv(
        clickhouse_url="https://ch.example.com",
        clickhouse_user="u",
        clickhouse_password="p",
        clickhouse_database="d",
    )
    kwargs = live_env_to_client_kwargs(env)
    assert kwargs["host"] == "ch.example.com"
    assert kwargs["port"] == 443
    assert kwargs["secure"] is True
    assert kwargs["username"] == "u"
    assert kwargs["password"] == "p"
    assert kwargs["database"] == "d"


def test_live_env_to_client_kwargs_parses_http_default_port() -> None:
    env = LiveEnv(
        clickhouse_url="http://localhost:8123",
        clickhouse_user="default",
        clickhouse_password="",
        clickhouse_database="default",
    )
    kwargs = live_env_to_client_kwargs(env)
    assert kwargs["port"] == 8123
    assert kwargs["secure"] is False


def test_live_env_to_client_kwargs_honors_explicit_port() -> None:
    env = LiveEnv(
        clickhouse_url="https://ch.example.com:9440",
        clickhouse_user="u",
        clickhouse_password="p",
        clickhouse_database="d",
    )
    assert live_env_to_client_kwargs(env)["port"] == 9440
