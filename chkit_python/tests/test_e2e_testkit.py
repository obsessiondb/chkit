"""Unit tests for :mod:`tests.e2e_testkit` — the shared e2e helper primitives."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from tests.e2e_testkit import (
    LiveEnv,
    create_journal_table_name,
    create_prefix,
    create_run_tag,
    format_test_diagnostic,
    get_required_env,
    live_env_to_client_kwargs,
    quote_ident,
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
    monkeypatch.delenv("CLICKHOUSE_URL", raising=False)
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


# ---------- resolve_live_env (soft-default variant) ----------


def test_resolve_live_env_defaults_to_local_docker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("CLICKHOUSE_URL", "CLICKHOUSE_HOST", "CLICKHOUSE_USER",
                 "CLICKHOUSE_PASSWORD", "CLICKHOUSE_DB"):
        monkeypatch.delenv(name, raising=False)
    env = resolve_live_env()
    assert env.clickhouse_url == "http://localhost:8123"
    assert env.clickhouse_user == "default"
    assert env.clickhouse_password == ""
    assert env.clickhouse_database == "default"


def test_resolve_live_env_env_overrides_win(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLICKHOUSE_URL", "https://custom:9000")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "pw")
    env = resolve_live_env()
    assert env.clickhouse_url == "https://custom:9000"
    assert env.clickhouse_password == "pw"


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
    assert kwargs["port"] == 8443
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


# ---------- quote_ident ----------


def test_quote_ident_wraps_in_backticks() -> None:
    assert quote_ident("events") == "`events`"


def test_quote_ident_doubles_embedded_backticks() -> None:
    assert quote_ident("weird`name") == "`weird``name`"


# ---------- create_run_tag / create_prefix / create_journal_table_name ----------


def test_create_run_tag_is_unique_across_calls() -> None:
    tags = {create_run_tag() for _ in range(100)}
    assert len(tags) == 100  # collision would be a serious RNG regression


def test_create_prefix_shape_matches_ts() -> None:
    prefix = create_prefix("cluster")
    assert prefix.startswith("chkit_e2e_cluster_")
    assert prefix.endswith("_")


def test_create_journal_table_name_prefers_github_run_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GITHUB_RUN_ID", "run-42")
    assert create_journal_table_name("dry") == "_chkit_migrations_dry_run-42"


def test_create_journal_table_name_falls_back_to_ts_and_rand(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GITHUB_RUN_ID", raising=False)
    name = create_journal_table_name("dry")
    assert name.startswith("_chkit_migrations_dry_")
    # Two calls without GITHUB_RUN_ID must diverge (random suffix).
    assert create_journal_table_name("dry") != create_journal_table_name("dry")


# ---------- format_test_diagnostic ----------


@dataclass
class _FakeResult:
    exit_code: int
    output: str


def test_format_test_diagnostic_renders_the_essentials() -> None:
    result = _FakeResult(exit_code=2, output="boom\n")
    msg = format_test_diagnostic("generate --json", result)
    assert "--- generate --json ---" in msg
    assert "exitCode: 2" in msg
    assert "output:\nboom\n" in msg
    assert "extra" not in msg


def test_format_test_diagnostic_includes_extra_when_supplied() -> None:
    result = _FakeResult(exit_code=1, output="")
    msg = format_test_diagnostic(
        "generate", result, extra={"cwd": "/tmp/x", "pending": 3}
    )
    assert '"cwd": "/tmp/x"' in msg
    assert '"pending": 3' in msg
