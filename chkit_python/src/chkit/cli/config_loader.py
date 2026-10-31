"""Load and validate a user's ``clickhouse.config.py`` config file."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

from chkit.cli.config_merge import merge_user_config
from chkit.cli.user_config import (
    get_user_credentials_path,
    get_user_profile_config_path,
)
from chkit.core import SYNTHESIZED_CONFIG_PATH
from chkit.core.model import (
    ChxConfigEnv,
    ChxResolvedConfig,
    ChxUserConfig,
    resolve_config,
)


def _load_module(config_path: Path, module_name: str) -> Any:
    spec = importlib.util.spec_from_file_location(module_name, config_path)
    if spec is None or spec.loader is None:
        msg = f"Unable to load config module from {config_path}"
        raise RuntimeError(msg)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


DEFAULT_CONFIG_FILE = "clickhouse.config.py"

# Commands that need a project config even when a user profile exists
# (``PROJECT_ONLY_COMMANDS`` in ``packages/cli/src/bin/chkit.ts``).
PROJECT_ONLY_COMMANDS = frozenset(
    {"generate", "migrate", "status", "drift", "check", "snapshot", "codegen", "pull"}
)


class ProjectConfigRequiredError(RuntimeError):
    """A project-only command ran from the user profile alone."""

    code = "project_config_required"


def _read_raw_config(path: Path, env: ChxConfigEnv | None, module_name: str) -> Any:
    module = _load_module(path, module_name)
    raw_config = getattr(module, "config", None)
    if raw_config is None:
        msg = f"Config file {path} must export a `config` attribute"
        raise AttributeError(msg)

    if callable(raw_config) and not isinstance(raw_config, ChxUserConfig):
        raw_config = raw_config(env if env is not None else ChxConfigEnv())
    return raw_config


def _to_user_config(raw_config: Any) -> ChxUserConfig:
    return (
        raw_config
        if isinstance(raw_config, ChxUserConfig)
        else ChxUserConfig.model_validate(raw_config)
    )


def _read_profile_layer(
    env: ChxConfigEnv | None, *, allow_synthesized: bool
) -> ChxUserConfig | None:
    """Port of TS ``readProfileLayer``: the profile config, else a profile that
    registers only ``obsessiondb()`` when ObsessionDB credentials exist (or when
    ``allow_synthesized``, for ``obsessiondb`` / ``plugin obsessiondb``)."""
    profile_path = get_user_profile_config_path()
    if profile_path.exists():
        profile_raw = _read_raw_config(profile_path, env, "chkit_profile_config")
        return _to_user_config(profile_raw)
    if get_user_credentials_path().exists() or allow_synthesized:
        # Imported here: the plugin imports chkit.cli modules.
        from chkit_plugin_obsessiondb import obsessiondb  # noqa: PLC0415

        return ChxUserConfig.model_validate({"schema": [], "plugins": [obsessiondb()]})
    return None


def load_config(
    config_path: Path | None = None,
    env: ChxConfigEnv | None = None,
    *,
    allow_synthesized_profile: bool = False,
) -> ChxResolvedConfig:
    """Resolve a ``ChxResolvedConfig`` from a config file.

    The default path is ``./clickhouse.config.py`` — matching the TypeScript
    ``clickhouse.config.ts`` convention. The module must export a ``config``
    attribute: a ``ChxUserConfig``, a dict that validates against it, or —
    mirroring the TS function-config form — a callable
    ``(env: ChxConfigEnv) -> config`` for dynamic per-command configs.

    As in TS, a user profile config (``<user config dir>/config.py``, same
    export) is layered under the project config when it exists: project values
    win, see :func:`merge_user_config`. ``schema`` is optional, as in TS, so a
    profile may leave it out. Without ``config.py``, ObsessionDB credentials
    stand in for a profile that registers ``obsessiondb()``.

    Without a project config (and no explicit ``config_path``) the profile is
    used alone, except for :data:`PROJECT_ONLY_COMMANDS` (``env.command``).
    """
    path = config_path if config_path is not None else Path(DEFAULT_CONFIG_FILE)
    if path.exists():
        user_config = _to_user_config(_read_raw_config(path, env, "chkit_user_config"))
        profile = _read_profile_layer(env, allow_synthesized=allow_synthesized_profile)
        if profile is not None:
            user_config = merge_user_config(profile, user_config)
        return resolve_config(user_config)

    if config_path is not None:
        msg = f"Config file not found: {path}"
        raise FileNotFoundError(msg)

    command = env.command if env is not None else None
    profile = _read_profile_layer(env, allow_synthesized=allow_synthesized_profile)
    if profile is None:
        if command == "query":
            msg = (
                f"No project config found at {path}, and no ObsessionDB profile is available.\n"
                "Run 'chkit obsessiondb login' to query ObsessionDB from any directory, "
                "or run 'chkit init' in a project."
            )
        else:
            msg = (
                f"Config file not found: {path}\n"
                "Either run 'chkit init' in your project, or run "
                "'chkit obsessiondb login' to use chkit from any directory."
            )
        raise FileNotFoundError(msg)
    if command in PROJECT_ONLY_COMMANDS:
        msg = (
            f'Command "{command}" requires a project config ({DEFAULT_CONFIG_FILE}) '
            "in the current directory.\n"
            "You are running chkit from a user profile (no local config found)."
        )
        raise ProjectConfigRequiredError(msg)
    return resolve_config(profile)


def loaded_config_path(config_path: Path | None = None) -> str:
    """The path TS ``LoadedConfig.path`` reports for :func:`load_config`: the
    project config, else the profile ``config.py``, else
    ``SYNTHESIZED_CONFIG_PATH``. The ObsessionDB plugin keeps the selected
    service of the last two in the user config dir, as in TS."""
    path = config_path if config_path is not None else Path(DEFAULT_CONFIG_FILE)
    if config_path is not None or path.exists():
        return str(path)
    profile_path = get_user_profile_config_path()
    return str(profile_path) if profile_path.exists() else SYNTHESIZED_CONFIG_PATH
