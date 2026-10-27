"""Options of the registered backfill plugin.

Port of ``packages/plugin-obsessiondb/src/backfill/plugin-options.ts``.

``submit`` and the submitted-job check run in this plugin, so they read the
backfill plugin's options here to use the same state directory and planning
options as the local ``plan``.
"""

from __future__ import annotations

from typing import cast

from chkit_plugin_backfill.options import PluginConfig


def resolve_backfill_plugin_options(plugins: object) -> PluginConfig:
    """The ``backfill({...})`` options; defaults when no backfill plugin is registered."""
    if not isinstance(plugins, list):
        return PluginConfig()
    for plugin in cast("list[object]", plugins):
        manifest = getattr(plugin, "manifest", None)
        if getattr(manifest, "name", None) != "backfill":
            continue
        options = getattr(getattr(plugin, "hooks", None), "options", None)
        return options if isinstance(options, PluginConfig) else PluginConfig()
    return PluginConfig()


def resolve_backfill_state_dir(plugins: object) -> str | None:
    """The configured backfill ``stateDir``; ``None`` for the default directory."""
    return resolve_backfill_plugin_options(plugins).state_dir


__all__ = ["resolve_backfill_plugin_options", "resolve_backfill_state_dir"]
