"""`chkit snapshot rebuild` — rewrite snapshot.json from the schema definitions.

1:1 port of ``packages/cli/src/commands/snapshot/{command,rebuild}.ts``.
Definitions are loaded, passed through the plugin hooks, validated and written
exactly as ``chkit generate`` does; no migration is planned or written. Meant
for a snapshot.json left with merge conflict markers by two branches that each
ran ``generate``.

Flags: ``--dryrun``, ``--json``, ``--config``, plus ``--force-shared-engines``
/ ``--no-shared-engines`` for the ObsessionDB hook. ``--table`` is rejected.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated, Any

import typer

from chkit.cli.commands.snapshot_output import (
    PreviousSnapshotReport,
    SnapshotRebuildPayload,
    emit_snapshot_rebuild_output,
)
from chkit.cli.config_loader import load_config
from chkit.cli.json_output import emit_json, emit_json_error
from chkit.cli.migration_store import write_snapshot
from chkit.cli.plugin_runtime import PluginRuntime, load_plugin_runtime
from chkit.cli.schema_loader import load_schema_definitions_with_hooks
from chkit.cli.shared_engine_flags import (
    ForceSharedEnginesOption,
    NoSharedEnginesOption,
    shared_engine_hook_flags,
)
from chkit.cli.snapshot_document import (
    ParsedSnapshotDocument,
    UnreadableSnapshotDocument,
    diff_snapshot_definitions,
    parse_snapshot_document,
)
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import (
    ChxConfigEnv,
    ChxResolvedConfig,
    ChxValidationError,
    SchemaDefinition,
)
from chkit.core.snapshot import create_snapshot
from chkit.core.validate import validate_definitions
from chkit.plugins import ChxPlugin

SNAPSHOT_USAGE = "Usage: chkit snapshot rebuild [--dryrun] [--json]"
SNAPSHOT_HELP = (
    "Rebuild snapshot.json from schema definitions "
    "(usage: chkit snapshot rebuild [--dryrun])"
)


class SnapshotCommandError(RuntimeError):
    """A usage or rebuild failure, reported like the TS top-level error handler."""


def run(  # noqa: PLR0917 - typer maps each option to a parameter
    args: Annotated[
        list[str] | None,
        typer.Argument(
            help="Subcommand: rebuild (chkit snapshot rebuild [--dryrun]).",
            show_default=False,
        ),
    ] = None,
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    table_selector: Annotated[
        str | None,
        typer.Option("--table", "-t", help="Not supported: rebuild rewrites the whole snapshot."),
    ] = None,
    dryrun: Annotated[
        bool,
        typer.Option("--dryrun", help="Print the rebuild report without writing snapshot.json"),
    ] = False,
    output_json: Annotated[
        bool,
        typer.Option("--json", help="Emit a JSON-formatted summary."),
    ] = False,
    force_shared_engines: ForceSharedEnginesOption = False,
    no_shared_engines: NoSharedEnginesOption = False,
) -> None:
    try:
        config = load_config(config_path, ChxConfigEnv(command="snapshot"))
        _assert_rebuild_invocation(list(args or []), table_selector)
        plugin_runtime = load_plugin_runtime(
            [p for p in config.plugins if isinstance(p, ChxPlugin)]
        )
        exit_code = run_snapshot_rebuild(
            dryrun=dryrun,
            json_mode=output_json,
            config=config,
            config_path=str(config_path or "clickhouse.config.py"),
            flags=shared_engine_hook_flags(
                force_shared_engines=force_shared_engines,
                no_shared_engines=no_shared_engines,
            ),
            plugin_runtime=plugin_runtime,
        )
    except typer.Exit:
        raise
    except Exception as error:
        _report_error(error, json_mode=output_json)
        raise typer.Exit(code=1) from error
    if exit_code != 0:
        raise typer.Exit(code=exit_code)


def run_snapshot_rebuild(
    *,
    dryrun: bool,
    json_mode: bool,
    config: ChxResolvedConfig,
    config_path: str,
    flags: dict[str, Any],
    plugin_runtime: PluginRuntime,
) -> int:
    """Rewrite snapshot.json from the schema definitions; returns the exit code."""
    meta_dir = Path(os.path.abspath(config.meta_dir))
    snapshot_file = meta_dir / "snapshot.json"

    loaded = load_schema_definitions_with_hooks(
        command="snapshot",
        config=config,
        config_path=config_path,
        flags=flags,
        json_mode=json_mode,
        plugin_runtime=plugin_runtime,
    )
    # A hook may return definitions that are not canonical. The snapshot always
    # stores canonical definitions, so canonicalize once and validate, compare,
    # count and write that same list.
    definitions = canonicalize_definitions(loaded)

    # Same validation and error contract as `chkit generate`.
    issues = validate_definitions(definitions)
    if issues:
        if json_mode:
            emit_json(
                "snapshot",
                {
                    "error": "validation_failed",
                    "issues": [issue.model_dump(mode="json") for issue in issues],
                },
            )
            return 1
        details = "\n".join(f"- [{issue.code}] {issue.message}" for issue in issues)
        msg = f"{ChxValidationError(issues)}\n{details}"
        raise SnapshotCommandError(msg)

    previous = _describe_previous_snapshot(snapshot_file, definitions)
    up_to_date = previous.status == "parsed" and previous.change_count == 0
    # An unchanged snapshot is left alone, so a rebuild never churns `generatedAt`.
    written = not dryrun and not up_to_date
    if written:
        write_snapshot(meta_dir, create_snapshot(definitions))

    emit_snapshot_rebuild_output(
        SnapshotRebuildPayload(
            mode="plan" if dryrun else "write",
            snapshot_file=str(snapshot_file),
            written=written,
            definition_count=len(definitions),
            previous=previous,
        ),
        json_mode=json_mode,
    )
    return 0


def _assert_rebuild_invocation(args: list[str], table_selector: str | None) -> None:
    if not args:
        msg = f"Missing snapshot subcommand. Available: rebuild.\n{SNAPSHOT_USAGE}"
        raise SnapshotCommandError(msg)
    subcommand, *rest = args
    if subcommand != "rebuild":
        msg = (
            f'Unknown snapshot subcommand "{subcommand}". Available: rebuild.\n'
            f"{SNAPSHOT_USAGE}"
        )
        raise SnapshotCommandError(msg)
    if rest:
        msg = (
            f'Unexpected argument "{rest[0]}" for `chkit snapshot rebuild`.\n'
            f"{SNAPSHOT_USAGE}"
        )
        raise SnapshotCommandError(msg)
    if table_selector is not None:
        msg = (
            "`chkit snapshot rebuild` always rewrites the whole snapshot and does not "
            "support --table. Run it without --table."
        )
        raise SnapshotCommandError(msg)


def _describe_previous_snapshot(
    snapshot_file: Path, next_definitions: list[SchemaDefinition]
) -> PreviousSnapshotReport:
    if not snapshot_file.exists():
        return PreviousSnapshotReport(status="missing")
    raw = snapshot_file.read_text(encoding="utf-8")

    parsed: ParsedSnapshotDocument
    try:
        parsed = parse_snapshot_document(raw)
    except Exception:  # any shape error means "not a chkit snapshot"
        # Valid JSON whose entries cannot be read as chkit definitions. The rebuild
        # replaces it anyway; it just cannot be compared.
        return PreviousSnapshotReport(status="unreadable", reason="invalid_shape")

    if isinstance(parsed, UnreadableSnapshotDocument):
        if parsed.reason == "conflict_markers":
            return PreviousSnapshotReport(status="conflicted")
        return PreviousSnapshotReport(status="unreadable", reason=parsed.reason)

    diff = diff_snapshot_definitions(list(parsed.snapshot.definitions), next_definitions)
    return PreviousSnapshotReport(
        status="parsed", added=diff.added, removed=diff.removed, changed=diff.changed
    )


def _report_error(error: Exception, *, json_mode: bool) -> None:
    """TS top-level catch: the message on stderr, plus a JSON error envelope on
    stdout under ``--json``."""
    message = str(error) or type(error).__name__
    typer.echo(message, err=True)
    if json_mode:
        emit_json_error("snapshot", {"code": "error", "message": message})
