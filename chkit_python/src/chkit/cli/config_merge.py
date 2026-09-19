"""Layer a user-profile config under a project config.

1:1 port of ``packages/cli/src/runtime/config-merge.ts``. Semantics match
the TS exactly:

- Overlay scalar fields (``schema``, ``out_dir``, ``migrations_dir``,
  ``meta_dir``) win when defined.
- ``clickhouse`` is merged shallowly (overlay keys win).
- ``plugins`` is merged by plugin name: overlay entries replace base
  entries with the same name; entries present only in base or only in
  overlay are preserved (overlay entries appended after preserved base).
- ``check`` / ``safety`` are merged shallowly via Pydantic ``model_copy``.

The function works on :class:`ChxUserConfig` (the pre-validation,
user-facing shape) so it can be layered before the project resolver runs.
"""

from __future__ import annotations

from typing import Any

from chkit.core.model import (
    ChxCheckConfig,
    ChxSafetyConfig,
    ChxUserClickHouseConfig,
    ChxUserConfig,
)


def plugin_name_of(registration: Any) -> str | None:
    """Best-effort name extraction for a plugin registration entry."""
    if registration is None:
        return None
    # Direct ChxPlugin (manifest.name)
    manifest = getattr(registration, "manifest", None)
    if manifest is not None:
        name = getattr(manifest, "name", None)
        if isinstance(name, str) and name:
            return name
    # Wrapped registration {plugin: ChxPlugin, name?: str}
    if isinstance(registration, dict):
        if isinstance(registration.get("name"), str) and registration["name"]:
            return str(registration["name"])
        nested = registration.get("plugin")
        if nested is not None:
            return plugin_name_of(nested)
    name_attr = getattr(registration, "name", None)
    if isinstance(name_attr, str) and name_attr:
        return name_attr
    return None


def _merge_plugins(
    base: list[Any] | None, overlay: list[Any] | None
) -> list[Any] | None:
    if base is None and overlay is None:
        return None
    if base is None:
        return list(overlay or [])
    if overlay is None:
        return list(base)
    overlay_names: set[str] = {
        name for reg in overlay if (name := plugin_name_of(reg)) is not None
    }
    result: list[Any] = []
    for reg in base:
        name = plugin_name_of(reg)
        if name is not None and name in overlay_names:
            continue
        result.append(reg)
    result.extend(overlay)
    return result


def _merge_clickhouse(
    base: ChxUserClickHouseConfig | None,
    overlay: ChxUserClickHouseConfig | None,
) -> ChxUserClickHouseConfig | None:
    if base is None and overlay is None:
        return None
    if base is None:
        return overlay
    if overlay is None:
        return base
    return base.model_copy(
        update={
            k: v
            for k, v in overlay.model_dump(exclude_none=True).items()
            if v is not None
        }
    )


def _merge_shallow_check(
    base: ChxCheckConfig | None, overlay: ChxCheckConfig | None
) -> ChxCheckConfig | None:
    if base is None and overlay is None:
        return None
    if base is None:
        return overlay
    if overlay is None:
        return base
    return base.model_copy(
        update={
            k: v
            for k, v in overlay.model_dump(exclude_none=True).items()
            if v is not None
        }
    )


def _merge_shallow_safety(
    base: ChxSafetyConfig | None, overlay: ChxSafetyConfig | None
) -> ChxSafetyConfig | None:
    if base is None and overlay is None:
        return None
    if base is None:
        return overlay
    if overlay is None:
        return base
    return base.model_copy(
        update={
            k: v
            for k, v in overlay.model_dump(exclude_none=True).items()
            if v is not None
        }
    )


def merge_user_config(
    base: ChxUserConfig, overlay: ChxUserConfig
) -> ChxUserConfig:
    """Return a new :class:`ChxUserConfig` with ``overlay`` layered on ``base``.

    See module docstring for per-field semantics.
    """
    payload: dict[str, Any] = {
        "schema": overlay.schema_ if overlay.schema_ is not None else base.schema_,
        "outDir": overlay.out_dir if overlay.out_dir is not None else base.out_dir,
        "migrationsDir": (
            overlay.migrations_dir
            if overlay.migrations_dir is not None
            else base.migrations_dir
        ),
        "metaDir": overlay.meta_dir if overlay.meta_dir is not None else base.meta_dir,
        "plugins": _merge_plugins(base.plugins, overlay.plugins),
        "check": _merge_shallow_check(base.check, overlay.check),
        "safety": _merge_shallow_safety(base.safety, overlay.safety),
        "clickhouse": _merge_clickhouse(base.clickhouse, overlay.clickhouse),
    }
    return ChxUserConfig.model_validate({k: v for k, v in payload.items() if v is not None})


__all__ = ["merge_user_config", "plugin_name_of"]
