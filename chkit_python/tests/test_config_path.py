"""Tests for `chkit.core.config_path` — the synthesized-config sentinel."""

from __future__ import annotations

from chkit import SYNTHESIZED_CONFIG_PATH, is_synthesized_config_path
from chkit.core.config_path import (
    SYNTHESIZED_CONFIG_PATH as SENTINEL_FROM_MODULE,
)
from chkit.core.config_path import (
    is_synthesized_config_path as is_synthesized_from_module,
)


def test_sentinel_value_matches_ts() -> None:
    assert SYNTHESIZED_CONFIG_PATH == "<default:obsessiondb>"


def test_sentinel_reexported_from_module() -> None:
    assert SENTINEL_FROM_MODULE is SYNTHESIZED_CONFIG_PATH


def test_returns_true_for_sentinel() -> None:
    assert is_synthesized_config_path(SYNTHESIZED_CONFIG_PATH) is True


def test_returns_true_for_module_helper_with_top_level_sentinel() -> None:
    assert is_synthesized_from_module(SYNTHESIZED_CONFIG_PATH) is True


def test_returns_false_for_real_path() -> None:
    assert is_synthesized_config_path("clickhouse.config.py") is False
    assert is_synthesized_config_path("/etc/chkit/config.py") is False
    assert is_synthesized_config_path("C:\\projects\\app\\clickhouse.config.py") is False


def test_returns_false_for_empty_string() -> None:
    assert is_synthesized_config_path("") is False


def test_returns_false_for_similar_but_distinct_strings() -> None:
    assert is_synthesized_config_path("<default:obsessiondb>\n") is False
    assert is_synthesized_config_path(" <default:obsessiondb>") is False
    assert is_synthesized_config_path("<default:obsessionDB>") is False
