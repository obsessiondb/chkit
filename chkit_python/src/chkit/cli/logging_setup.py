"""Configure ``chkit.*`` loggers when ``CHKIT_DEBUG=1``.

Mirrors ``packages/cli/src/runtime/logging.ts`` and ``debug.ts`` but uses
Python's stdlib ``logging`` instead of ``@logtape`` (TS only). Behaviour:

- ``CHKIT_DEBUG=1`` (or ``true``) → enable DEBUG level, format ``[time]
  category - message``, write to stderr.
- Otherwise the loggers stay silent (WARNING + only).

Use ``debug(category, message, detail=None)`` to emit a structured debug
line without paying for it when debug is off.
"""

from __future__ import annotations

import logging
import os
from typing import Any

_CONFIGURED = False


def is_debug_enabled() -> bool:
    return os.environ.get("CHKIT_DEBUG", "").strip().lower() in {"1", "true"}


def configure_cli_logging() -> None:
    """Wire up the ``chkit`` logger tree once per process."""
    global _CONFIGURED  # noqa: PLW0603
    if _CONFIGURED:
        return
    _CONFIGURED = True

    if not is_debug_enabled():
        logging.getLogger("chkit").setLevel(logging.WARNING)
        return

    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(name)s] %(message)s")
    )
    root = logging.getLogger("chkit")
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    root.propagate = False


def debug(category: str, message: str, detail: Any = None) -> None:
    """Emit a debug line under ``chkit.<category>``; no-op when debug is off."""
    if not is_debug_enabled():
        return
    configure_cli_logging()
    logger = logging.getLogger(f"chkit.{category}")
    if detail is None:
        logger.debug(message)
    else:
        logger.debug("%s | %r", message, detail)
