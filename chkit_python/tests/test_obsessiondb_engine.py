"""Tests for `chkit_plugin_obsessiondb.engine` (Shared-engine rewrite)."""

from __future__ import annotations

import pytest

from chkit import ColumnDefinition, table, view
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedClickHouseConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit_plugin_obsessiondb.engine import (
    is_obsessiondb_host,
    resolve_strip_behavior,
    rewrite_shared_engines,
    strip_cloud_settings,
    strip_shared_prefix,
)


def _resolved(*, url: str | None = None) -> ChxResolvedConfig:
    ch: ChxResolvedClickHouseConfig | None = None
    if url is not None:
        ch = ChxResolvedClickHouseConfig(
            url=url, username="default", password="", database="default", secure=False
        )
    return ChxResolvedConfig(
        schema_=["./schema.py"],
        out_dir="./chkit",
        migrations_dir="./chkit/migrations",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False,
            fail_on_checksum_mismatch=True,
            fail_on_drift=False,
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
        clickhouse=ch,
    )


def _t(*, name: str, engine: str, settings: dict[str, object] | None = None):
    return table(
        database="db",
        name=name,
        engine=engine,
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
        settings=settings,
    )


# ---------- is_obsessiondb_host ----------


@pytest.mark.parametrize(
    "url",
    [
        "https://my-app.obsessiondb.com",
        "https://obsessiondb.com",
        "https://x.obsession.numia-dev.com",
        "https://obsession.numia-dev.com",
    ],
)
def test_is_obsessiondb_host_true_for_known_domains(url: str) -> None:
    assert is_obsessiondb_host(url) is True


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8123",
        "https://my-clickhouse.example.com",
        "https://obsessiondb.com.evil.com",  # confusing TLD
        "",
        "not-a-url",
    ],
)
def test_is_obsessiondb_host_false_for_others(url: str) -> None:
    assert is_obsessiondb_host(url) is False


# ---------- strip_shared_prefix ----------


def test_strip_shared_prefix_removes_shared() -> None:
    assert strip_shared_prefix("SharedMergeTree") == "MergeTree"
    assert strip_shared_prefix("SharedReplacingMergeTree") == "ReplacingMergeTree"


def test_strip_shared_prefix_passes_through_non_shared() -> None:
    assert strip_shared_prefix("MergeTree") == "MergeTree"
    assert strip_shared_prefix("Memory") == "Memory"
    assert strip_shared_prefix("ReplicatedMergeTree") == "ReplicatedMergeTree"


# ---------- strip_cloud_settings ----------


def test_strip_cloud_settings_drops_storage_policy() -> None:
    out = strip_cloud_settings({"storage_policy": "s3", "index_granularity": 8192})
    assert out.stripped == ["storage_policy"]
    assert out.settings == {"index_granularity": 8192}


def test_strip_cloud_settings_returns_none_when_only_cloud_key() -> None:
    out = strip_cloud_settings({"storage_policy": "s3"})
    assert out.stripped == ["storage_policy"]
    assert out.settings is None


def test_strip_cloud_settings_passes_through_when_no_cloud_keys() -> None:
    original = {"index_granularity": 8192}
    out = strip_cloud_settings(original)
    assert out.stripped == []
    assert out.settings is original


def test_strip_cloud_settings_handles_none() -> None:
    out = strip_cloud_settings(None)
    assert out.stripped == []
    assert out.settings is None


# ---------- resolve_strip_behavior ----------


def test_resolve_strip_behavior_force_shared_keeps_them() -> None:
    cfg = _resolved(url="http://localhost:8123")
    assert resolve_strip_behavior(cfg, {"--force-shared-engines": True}) is False


def test_resolve_strip_behavior_no_shared_always_strips() -> None:
    cfg = _resolved(url="https://x.obsessiondb.com")
    assert resolve_strip_behavior(cfg, {"--no-shared-engines": True}) is True


def test_resolve_strip_behavior_auto_keeps_on_obsessiondb_url() -> None:
    cfg = _resolved(url="https://my.obsessiondb.com")
    assert resolve_strip_behavior(cfg, {}) is False


def test_resolve_strip_behavior_auto_strips_on_other_url() -> None:
    cfg = _resolved(url="http://localhost:8123")
    assert resolve_strip_behavior(cfg, {}) is True


def test_resolve_strip_behavior_strips_when_no_clickhouse_block() -> None:
    cfg = _resolved(url=None)
    assert resolve_strip_behavior(cfg, {}) is True


def test_resolve_strip_behavior_accepts_snake_case_keys() -> None:
    cfg = _resolved(url=None)
    assert resolve_strip_behavior(cfg, {"force_shared_engines": True}) is False


# ---------- rewrite_shared_engines ----------


def test_rewrite_shared_engines_strips_engine_prefix() -> None:
    t = _t(name="events", engine="SharedMergeTree")
    out = rewrite_shared_engines([t])
    assert out.count == 1
    assert out.definitions[0].engine == "MergeTree"  # type: ignore[union-attr]


def test_rewrite_shared_engines_strips_storage_policy() -> None:
    t = _t(name="events", engine="MergeTree", settings={"storage_policy": "s3"})
    out = rewrite_shared_engines([t])
    assert out.count == 0
    assert out.stripped_settings == ["storage_policy"]
    [rewritten] = out.definitions
    assert rewritten.settings is None  # type: ignore[union-attr]


def test_rewrite_shared_engines_handles_both_at_once() -> None:
    t = _t(
        name="events",
        engine="SharedReplacingMergeTree",
        settings={"storage_policy": "s3", "index_granularity": 8192},
    )
    out = rewrite_shared_engines([t])
    assert out.count == 1
    assert out.stripped_settings == ["storage_policy"]
    [rewritten] = out.definitions
    assert rewritten.engine == "ReplacingMergeTree"  # type: ignore[union-attr]
    assert rewritten.settings == {"index_granularity": 8192}  # type: ignore[union-attr]


def test_rewrite_shared_engines_leaves_non_table_definitions_untouched() -> None:
    v = view(database="db", name="v", as_="SELECT 1")
    t = _t(name="events", engine="SharedMergeTree")
    out = rewrite_shared_engines([v, t])
    assert out.count == 1
    [view_out, table_out] = out.definitions
    assert view_out is v  # passed through by reference
    assert table_out.engine == "MergeTree"  # type: ignore[union-attr]


def test_rewrite_shared_engines_returns_input_when_no_changes() -> None:
    t = _t(name="events", engine="MergeTree")
    out = rewrite_shared_engines([t])
    assert out.count == 0
    assert out.stripped_settings == []
    assert out.definitions[0] is t


def test_rewrite_shared_engines_empty_list() -> None:
    out = rewrite_shared_engines([])
    assert out.definitions == []
    assert out.count == 0
    assert out.stripped_settings == []
