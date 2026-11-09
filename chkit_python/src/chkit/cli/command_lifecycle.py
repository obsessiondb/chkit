"""The on_init / on_complete pair around one CLI command.

Port of ``packages/cli/src/bin/chkit.ts``: once a command's on_init hooks have
run, its on_complete hooks run when it ends, with the exit code, on success
and on error. TS runs both in one place; here each command runs on_init
itself (:func:`run_on_init`), and the top-level group (``cli/main.py``) runs
on_complete (:func:`run_on_complete`) when the command returns or fails.
"""

from __future__ import annotations

from dataclasses import dataclass

from chkit.cli.plugin_runtime import PluginRuntime
from chkit.plugins import ChxOnCompleteContext, ChxOnInitContext


@dataclass(frozen=True, slots=True)
class _Started:
    runtime: PluginRuntime
    command: str
    is_interactive: bool
    json_mode: bool


_started: _Started | None = None


def reset() -> None:
    """Forget a command that ended without on_complete (one CLI process may
    run several commands, as the tests do)."""
    global _started  # noqa: PLW0603 - one CLI command at a time
    _started = None


def run_on_init(runtime: PluginRuntime, context: ChxOnInitContext) -> None:
    """Run the on_init hooks. Once they pass, on_complete runs when the command ends;
    as in TS, an on_init error ends the command without it."""
    global _started  # noqa: PLW0603 - one CLI command at a time
    runtime.run_on_init(context)
    _started = _Started(
        runtime=runtime,
        command=context.command,
        is_interactive=context.is_interactive,
        json_mode=context.json_mode,
    )


def run_on_complete(exit_code: int) -> None:
    """Run the on_complete hooks of the command whose on_init ran, once."""
    global _started
    started, _started = _started, None
    if started is None:
        return
    started.runtime.run_on_complete(
        ChxOnCompleteContext(
            command=started.command,
            is_interactive=started.is_interactive,
            json_mode=started.json_mode,
            exit_code=exit_code,
            options={},
        )
    )
