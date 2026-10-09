"""Build the ``ChxPlugin`` object that registers the ObsessionDB hooks + commands.

The factory ``obsessiondb()`` is what the user puts in their
``clickhouse.config.py`` ``plugins`` list. It contributes:

- ``on_schema_loaded`` — auto-rewrites ``Shared*`` engines + strips
  cloud-only settings when the target isn't an ObsessionDB host.
- Auth commands: ``login``, ``signup``, ``logout``, ``whoami`` —
  dispatched via ``chkit plugin obsessiondb <command>``.
- (Future) ``get_context``, service commands (list / select / claim /
  alias), and ``on_before_plugin_command`` for backfill routing.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from chkit.plugins import (
    ChxOnBeforePluginCommandContext,
    ChxOnBeforePluginCommandResult,
    ChxOnSchemaLoadedContext,
    ChxPlugin,
    ChxPluginCommand,
    ChxPluginCommandContext,
    ChxPluginManifest,
)
from chkit_plugin_obsessiondb.auth_login import (
    run_login,
    run_logout,
    run_whoami,
)
from chkit_plugin_obsessiondb.auth_signup import (
    SignupOptions,
    run_signup,
)
from chkit_plugin_obsessiondb.backfill_handler import handle_backfill_command
from chkit_plugin_obsessiondb.credentials import resolve_base_url
from chkit_plugin_obsessiondb.engine import (
    resolve_strip_behavior,
    rewrite_shared_engines,
)
from chkit_plugin_obsessiondb.service_commands import service_command_run


@dataclass(frozen=True, slots=True)
class ObsessionDBPluginOptions:
    """Plugin factory options. Reserved for future tunables."""


@dataclass
class _ObsessionDBHooks:
    """Concrete hook object the plugin runtime introspects via ``hasattr``."""

    json_mode_default: bool = False

    def on_before_plugin_command(
        self, ctx: ChxOnBeforePluginCommandContext
    ) -> ChxOnBeforePluginCommandResult:
        return handle_backfill_command(ctx)

    def on_schema_loaded(
        self, ctx: ChxOnSchemaLoadedContext
    ) -> list[Any] | None:
        flags = dict(ctx.flags) if ctx.flags else {}
        if not resolve_strip_behavior(ctx.config, flags):
            return None

        result = rewrite_shared_engines(list(ctx.definitions))
        if not ctx.json_mode:
            if result.count > 0:
                print(
                    f"obsessiondb: Rewrote {result.count} Shared engine(s) "
                    f"to standard ClickHouse equivalents."
                )
            if result.stripped_settings:
                unique = sorted(set(result.stripped_settings))
                print(
                    f"obsessiondb: Stripped cloud-only setting(s): "
                    f"{', '.join(unique)}"
                )
        return result.definitions


def _resolve_base_url_from_flags(flags: dict[str, Any]) -> str:
    """``--api-url`` overrides anything else; otherwise fall back to env/stored/default."""
    candidate = flags.get("--api-url") or flags.get("api_url")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    return resolve_base_url()


def _login_run(ctx: ChxPluginCommandContext) -> int:
    base_url = _resolve_base_url_from_flags(ctx.flags)
    return run_login(base_url, Path(ctx.config_path), ctx.print)


def _logout_run(ctx: ChxPluginCommandContext) -> int:
    return run_logout(ctx.print)


def _whoami_run(ctx: ChxPluginCommandContext) -> int:
    return run_whoami(ctx.print, json_mode=ctx.json_mode)


def _signup_run(ctx: ChxPluginCommandContext) -> int:
    base_url = _resolve_base_url_from_flags(ctx.flags)
    options = SignupOptions(
        email=_str_flag(ctx.flags, "--email"),
        code=_str_flag(ctx.flags, "--code"),
        org_name=_str_flag(ctx.flags, "--org-name"),
        request_only=bool(ctx.flags.get("--request-only") or ctx.flags.get("request_only")),
        json_mode=ctx.json_mode,
    )
    return run_signup(base_url, ctx.print, options)


def _str_flag(flags: dict[str, Any], name: str) -> str | None:
    value = flags.get(name) or flags.get(name.lstrip("-").replace("-", "_"))
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def create_obsessiondb_plugin(
    _options: ObsessionDBPluginOptions | None = None,
) -> ChxPlugin:
    """Return a ``ChxPlugin`` for inclusion in ``config.plugins``."""
    return ChxPlugin(
        manifest=ChxPluginManifest(name="obsessiondb", api_version=1),
        hooks=_ObsessionDBHooks(),
        commands=[
            ChxPluginCommand(
                name="login",
                description="Authenticate with ObsessionDB via device-code flow.",
                run=_login_run,
            ),
            ChxPluginCommand(
                name="logout",
                description="Remove stored ObsessionDB credentials.",
                run=_logout_run,
            ),
            ChxPluginCommand(
                name="whoami",
                description="Show the current ObsessionDB user.",
                run=_whoami_run,
            ),
            ChxPluginCommand(
                name="signup",
                description=(
                    "Sign up or log in with a one-time email code (passwordless)."
                ),
                run=_signup_run,
            ),
            ChxPluginCommand(
                name="service",
                description=(
                    "Manage ObsessionDB services: list / select / claim / alias."
                ),
                run=service_command_run,
            ),
        ],
        # Mirror of TS BACKFILL_EXTEND_COMMANDS: register the remote-routing
        # flags against the `backfill` plugin commands so the dispatcher
        # accepts them and the on_before_plugin_command hook can route on them.
        extend_commands=[
            {
                "command": ["backfill"],
                "flags": [
                    {
                        "name": "--local",
                        "type": "boolean",
                        "description": "Force local execution (skip remote routing)",
                    },
                ],
            },
            {
                "command": ["backfill"],
                "flags": [
                    {
                        "name": "--job-id",
                        "type": "string",
                        "description": "Remote job ID for status/cancel",
                    },
                    {
                        "name": "--service-slug",
                        "type": "string",
                        "description": "ObsessionDB service slug for listing jobs",
                    },
                ],
            },
        ],
    )


def obsessiondb(
    options: ObsessionDBPluginOptions | None = None,
) -> ChxPlugin:
    """Public factory matching the TS ``obsessiondb()`` registration helper."""
    return create_obsessiondb_plugin(options)
