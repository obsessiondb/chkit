"""Uniform error handling for plugin command implementations.

A plugin command's `run` implementation may raise a config error
(missing required option, invalid value) or a runtime error. The CLI
needs to distinguish them:

- exit 0 (or None / int returned by the handler) on success
- exit 1 on generic failure
- exit 2 on config error (specifically `isinstance(err, config_error_class)`)

Output formatting also varies: in `--json` mode we wrap the message in a
machine-readable envelope; otherwise we print a human-readable line.

This helper centralises that policy so every plugin command behaves
identically. Mirrors `wrapPluginRun` from `@chkit/core/plugin-error.ts`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


def wrap_plugin_run(
    *,
    command: str,
    label: str,
    json_mode: bool,
    print_: Callable[[Any], None],
    fn: Callable[[], int | None],
    config_error_class: type[Exception] | None = None,
) -> int | None:
    try:
        return fn()
    except Exception as error:
        message = str(error)
        if json_mode:
            print_({"ok": False, "command": command, "error": message})
        else:
            print_(f"{label} failed: {message}")
        if config_error_class is not None and isinstance(error, config_error_class):
            return 2
        return 1
