"""Service selection state files (per-project + user-global aliases).

1:1 port of ``packages/plugin-obsessiondb/src/service/storage.ts``.

Two files:

- ``<project_dir>/.chkit/obsessiondb.json`` — the service selected for
  this project (so ``chkit migrate`` etc. routes to the right cloud
  instance). Falls back to the user-global file if the project file is
  missing.
- ``$XDG_CONFIG_HOME/chkit/obsessiondb.json`` — user-global aliases
  (``--service <alias>`` lookup) and the user-global default selection.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict


class SelectedService(BaseModel):
    """One service selection stored under .chkit/obsessiondb.json.

    Only ``service_slug`` + ``service_name`` are required (matches the TS
    ``SelectedService`` shape). The extra organization / service id /
    cloud_provider / region fields are Python additions: filled in when the
    Python CLI writes the file, ignored / optional when reading a file written
    by the TS CLI. This keeps the two ports forward-compatible: a
    ``.chkit/obsessiondb.json`` written by either side deserializes on the
    other.
    """

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)

    service_name: str
    service_slug: str
    organization_id: str | None = None
    organization_slug: str | None = None
    service_id: str | None = None
    cloud_provider: str | None = None
    region: str | None = None


class ServiceAliases(BaseModel):
    """User-global ``alias → service slug`` map."""

    model_config = ConfigDict(frozen=True, extra="ignore")

    aliases: dict[str, SelectedService] = {}


def _project_state_path(config_path: str | Path) -> Path:
    config = Path(config_path).resolve()
    return config.parent / ".chkit" / "obsessiondb.json"


def _user_state_path() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "chkit" / "obsessiondb.json"


def _read_json(path: Path) -> dict[str, Any] | None:
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
    return parsed


def load_selected_service(config_path: str | Path) -> SelectedService | None:
    """Load the project's selected service, falling back to the user-global one."""
    project_payload = _read_json(_project_state_path(config_path))
    candidate: dict[str, Any] | None = project_payload
    if candidate is None:
        user_payload = _read_json(_user_state_path())
        if user_payload is not None and isinstance(
            user_payload.get("selected"), dict
        ):
            candidate = user_payload["selected"]
    if candidate is None:
        return None
    try:
        return SelectedService.model_validate(candidate)
    except Exception:
        return None


def save_selected_service(
    config_path: str | Path, service: SelectedService
) -> None:
    """Persist the project's selected service under ``.chkit/obsessiondb.json``."""
    path = _project_state_path(config_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = service.model_dump()
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def load_service_aliases() -> ServiceAliases:
    """Read the user-global ``alias → SelectedService`` map."""
    payload = _read_json(_user_state_path())
    if payload is None or not isinstance(payload.get("aliases"), dict):
        return ServiceAliases()
    out: dict[str, SelectedService] = {}
    for alias_name, raw in payload["aliases"].items():
        if not isinstance(raw, dict):
            continue
        try:
            out[str(alias_name)] = SelectedService.model_validate(raw)
        except Exception:
            continue
    return ServiceAliases(aliases=out)


def save_service_alias(alias_name: str, service: SelectedService) -> None:
    """Add or update one alias entry in the user-global file."""
    path = _user_state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = _read_json(path) or {}
    aliases = existing.get("aliases")
    if not isinstance(aliases, dict):
        aliases = {}
    aliases[alias_name] = service.model_dump()
    existing["aliases"] = aliases
    path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")


def remove_service_alias(alias_name: str) -> bool:
    """Drop one alias entry. Returns True if the alias was present."""
    path = _user_state_path()
    existing = _read_json(path)
    if existing is None:
        return False
    aliases = existing.get("aliases")
    if not isinstance(aliases, dict) or alias_name not in aliases:
        return False
    del aliases[alias_name]
    existing["aliases"] = aliases
    path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
    return True
