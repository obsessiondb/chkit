"""Sentinel marking a synthesized (in-memory) config path.

A config can be loaded from disk (real `clickhouse.config.py` path) or
synthesized at runtime by a plugin (e.g. obsessiondb profile resolution).
Synthesized configs have no on-disk file, so we tag them with this
intentionally unparseable string and let downstream code branch on
`is_synthesized_config_path(path)`.
"""

from __future__ import annotations

from typing import Final

SYNTHESIZED_CONFIG_PATH: Final[str] = "<default:obsessiondb>"


def is_synthesized_config_path(path: str) -> bool:
    return path == SYNTHESIZED_CONFIG_PATH
