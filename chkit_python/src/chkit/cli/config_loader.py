"""Load and validate a user's ``clickhouse.config.py`` config file."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

from chkit.core.model import ChxResolvedConfig, ChxUserConfig, resolve_config


def _load_module(config_path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("chkit_user_config", config_path)
    if spec is None or spec.loader is None:
        msg = f"Unable to load config module from {config_path}"
        raise RuntimeError(msg)
    module = importlib.util.module_from_spec(spec)
    sys.modules["chkit_user_config"] = module
    spec.loader.exec_module(module)
    return module


DEFAULT_CONFIG_FILE = "clickhouse.config.py"


def load_config(config_path: Path | None = None) -> ChxResolvedConfig:
    """Resolve a ``ChxResolvedConfig`` from a config file.

    The default path is ``./clickhouse.config.py`` — matching the TypeScript
    ``clickhouse.config.ts`` convention. The module must export a ``config``
    attribute of type ``ChxUserConfig`` (or a dict that validates against
    ``ChxUserConfig``).
    """
    path = config_path if config_path is not None else Path(DEFAULT_CONFIG_FILE)
    if not path.exists():
        msg = f"Config file not found: {path}"
        raise FileNotFoundError(msg)

    module = _load_module(path)
    raw_config = getattr(module, "config", None)
    if raw_config is None:
        msg = f"Config file {path} must export a `config` attribute"
        raise AttributeError(msg)

    user_config = (
        raw_config
        if isinstance(raw_config, ChxUserConfig)
        else ChxUserConfig.model_validate(raw_config)
    )
    return resolve_config(user_config)
