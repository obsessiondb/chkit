"""Load and validate a user's ``clickhouse.config.py`` config file."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

from chkit.cli.config_merge import merge_user_config
from chkit.cli.user_config import get_user_profile_config_path
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


def load_config(
    config_path: Path | None = None, env: ChxConfigEnv | None = None
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
    profile may leave it out.
    """
    path = config_path if config_path is not None else Path(DEFAULT_CONFIG_FILE)
    if not path.exists():
        msg = f"Config file not found: {path}"
        raise FileNotFoundError(msg)

    user_config = _to_user_config(_read_raw_config(path, env, "chkit_user_config"))
    profile_path = get_user_profile_config_path()
    if profile_path.exists():
        profile_raw = _read_raw_config(profile_path, env, "chkit_profile_config")
        user_config = merge_user_config(_to_user_config(profile_raw), user_config)
    return resolve_config(user_config)
