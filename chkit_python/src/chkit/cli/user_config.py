"""XDG-compliant user-config directory helpers.

1:1 port of ``packages/cli/src/runtime/user-config.ts``.

The Python file names use the language convention (``.py`` instead of
``.ts``) — see DRIFT.md > Cross-cutting polish for the rationale.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Final

USER_PROFILE_CONFIG_FILE: Final[str] = "config.py"
"""Per-user chkit profile config file name (under the user-config dir)."""

USER_CREDENTIALS_FILE: Final[str] = "credentials.json"
"""Per-user credentials file name (shared with the obsessiondb plugin)."""


def get_user_config_dir() -> Path:
    """Return the chkit user-config directory (creates nothing).

    Honors ``XDG_CONFIG_HOME`` when set, else defaults to ``~/.config``.
    The returned path is ``<base>/chkit``.
    """
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "chkit"


def get_user_profile_config_path() -> Path:
    return get_user_config_dir() / USER_PROFILE_CONFIG_FILE


def get_user_credentials_path() -> Path:
    return get_user_config_dir() / USER_CREDENTIALS_FILE


__all__ = [
    "USER_CREDENTIALS_FILE",
    "USER_PROFILE_CONFIG_FILE",
    "get_user_config_dir",
    "get_user_credentials_path",
    "get_user_profile_config_path",
]
