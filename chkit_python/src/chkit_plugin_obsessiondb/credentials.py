"""ObsessionDB credentials file (XDG-compliant).

1:1 port of ``packages/plugin-obsessiondb/src/auth/credentials.ts``.

Stores ``{access_token, base_url}`` under
``$XDG_CONFIG_HOME/chkit/credentials.json`` (default ``~/.config/chkit/``).
On POSIX the file mode is ``0o600`` and the parent directory ``0o700`` —
this matches the TS implementation and protects the access token from
other local users.
"""

from __future__ import annotations

import contextlib
import json
import os
import platform
import stat
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict

DEFAULT_BASE_URL = "https://console-api.obsessiondb.com"


class Credentials(BaseModel):
    """Persisted auth state for the ObsessionDB API."""

    model_config = ConfigDict(frozen=True, extra="ignore")

    access_token: str
    base_url: str


def get_credentials_path() -> Path:
    """Return ``$XDG_CONFIG_HOME/chkit/credentials.json``.

    Falls back to ``~/.config/chkit/credentials.json`` when XDG isn't set,
    matching the TS behaviour on every supported platform.
    """
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "chkit" / "credentials.json"


def load_credentials() -> Credentials | None:
    """Read + validate the credentials file. Returns None on any failure."""
    path = get_credentials_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        parsed: Any = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    access_token = parsed.get("access_token")
    base_url = parsed.get("base_url")
    if not isinstance(access_token, str) or not isinstance(base_url, str):
        return None
    return Credentials(access_token=access_token, base_url=base_url)


def save_credentials(creds: Credentials) -> None:
    """Write the credentials file with mode 0o600 (POSIX)."""
    path = get_credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if platform.system() != "Windows":
        with contextlib.suppress(OSError):
            os.chmod(path.parent, stat.S_IRWXU)
    payload = creds.model_dump()
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    if platform.system() != "Windows":
        with contextlib.suppress(OSError):
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def clear_credentials() -> bool:
    """Delete the credentials file. Returns True if it existed and was removed."""
    path = get_credentials_path()
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    except OSError:
        return False
    return True


def resolve_base_url(stored: str | None = None) -> str:
    """``OBSESSIONDB_API_URL`` env > stored value > default. Matches TS priority."""
    env_value = os.environ.get("OBSESSIONDB_API_URL", "").strip()
    if env_value:
        return env_value
    if stored:
        return stored
    return DEFAULT_BASE_URL
