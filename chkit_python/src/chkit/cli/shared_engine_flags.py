"""``--force-shared-engines`` / ``--no-shared-engines`` for the commands that run
the ``on_schema_loaded`` hooks (``generate`` and ``snapshot rebuild``).

The TS ObsessionDB plugin registers these through ``extendCommands``. Typer
commands are static, so chkit-py declares them on the two commands where they
take effect and hands them to the hooks under the ``--``-prefixed keys the TS
flag parser produces (``resolve_strip_behavior`` reads those keys).
"""

from __future__ import annotations

from typing import Annotated, Any

import typer

FORCE_SHARED_ENGINES_HELP = (
    "Keep the storage_policy table setting even when the URL is not recognized "
    "as ObsessionDB (takes effect in generate and snapshot rebuild)"
)
NO_SHARED_ENGINES_HELP = (
    "Strip the storage_policy table setting even when targeting ObsessionDB "
    "(takes effect in generate and snapshot rebuild)"
)

ForceSharedEnginesOption = Annotated[
    bool, typer.Option("--force-shared-engines", help=FORCE_SHARED_ENGINES_HELP)
]
NoSharedEnginesOption = Annotated[
    bool, typer.Option("--no-shared-engines", help=NO_SHARED_ENGINES_HELP)
]


def shared_engine_hook_flags(
    *, force_shared_engines: bool, no_shared_engines: bool
) -> dict[str, Any]:
    """Parsed-flag dict for the plugin hooks: only flags that were passed."""
    flags: dict[str, Any] = {}
    if force_shared_engines:
        flags["--force-shared-engines"] = True
    if no_shared_engines:
        flags["--no-shared-engines"] = True
    return flags
