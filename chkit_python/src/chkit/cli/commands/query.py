"""`chkit query` — run a SQL string against the configured target.

1:1 port of ``packages/cli/src/commands/query.ts``.

- Single positional SQL arg (multi-positional rejected with hint).
- ``--json`` returns the ``ClickHouseJsonQueryResult`` envelope.
- Text mode emits an aligned table with row count.
- Errors are cleaned of the injected ``FORMAT JSON`` clause and the
  ``Expected one of`` token dump is truncated to keep output readable.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Annotated, Any

import typer

from chkit.cli.config_loader import load_config
from chkit.clickhouse.client import (
    ClickHouseClient,
    ClickHouseJsonQueryResult,
)
from chkit.core.model import ChxConfigEnv

DEFAULT_SHOWN_ROW_LIMIT = 25
EXPECTED_TOKEN_CAP = 8

_INJECTED_FORMAT_RE = re.compile(r"\s+FORMAT\s+JSON(?:EachRow)?\b", re.IGNORECASE)
_EXPECTED_ONE_OF_RE = re.compile(r"Expected one of: ([^.]*)\.")


def clean_query_error(error: BaseException) -> BaseException:
    """Strip injected FORMAT JSON + truncate "Expected one of" lists."""
    if not isinstance(error, Exception):
        return error
    original = str(error)
    message = _INJECTED_FORMAT_RE.sub("", original)

    def _truncate_expected(match: re.Match[str]) -> str:
        tokens = [t.strip() for t in match.group(1).split(",") if t.strip()]
        if len(tokens) <= EXPECTED_TOKEN_CAP:
            return f"Expected one of: {', '.join(tokens)}."
        shown = ", ".join(tokens[:EXPECTED_TOKEN_CAP])
        return (
            f"Expected one of: {shown}, … "
            f"({len(tokens) - EXPECTED_TOKEN_CAP} more)."
        )

    message = _EXPECTED_ONE_OF_RE.sub(_truncate_expected, message)
    if message == original:
        return error
    return type(error)(message.strip()) if isinstance(error, Exception) else error


def format_query_json(payload: ClickHouseJsonQueryResult) -> str:
    return json.dumps(payload.model_dump(mode="json"), indent=2)


def _stringify_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (bool, int, float)):
        return str(value)
    return json.dumps(value, default=str)


def format_rows(
    rows: list[dict[str, Any]],
    *,
    limit: int | None = None,
) -> str:
    """Format rows as an aligned text table with a trailing row-count line."""
    if not rows:
        return "(no rows)"

    effective_limit = DEFAULT_SHOWN_ROW_LIMIT if limit is None else limit
    shown_rows = rows[:effective_limit] if effective_limit >= 0 else rows

    seen: list[str] = []
    seen_set: set[str] = set()
    for row in rows:
        for key in row:
            if key not in seen_set:
                seen.append(key)
                seen_set.add(key)
    columns = seen

    stringified = [[_stringify_cell(row.get(col)) for col in columns] for row in shown_rows]

    widths = [
        max((len(stringified[r][c]) for r in range(len(stringified))), default=0)
        for c in range(len(columns))
    ]
    for c, col in enumerate(columns):
        widths[c] = max(widths[c], len(col))

    header_line = " │ ".join(col.ljust(widths[i]) for i, col in enumerate(columns))
    separator_line = "─┼─".join("─" * w for w in widths)
    body_lines = [
        " │ ".join(cell.ljust(widths[i]) for i, cell in enumerate(row))
        for row in stringified
    ]

    plural = "" if len(rows) == 1 else "s"
    suffix = f", showing {len(shown_rows)}" if len(shown_rows) < len(rows) else ""
    summary = f"({len(rows)} row{plural}{suffix})"

    return "\n".join([header_line, separator_line, *body_lines, "", summary])


def run(
    sql: Annotated[
        list[str] | None,
        typer.Argument(
            help='SQL string (quote it, e.g. `chkit query "SELECT 1"`).',
        ),
    ] = None,
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    output_json: Annotated[
        bool, typer.Option("--json", help="Emit the ClickHouseJsonQueryResult envelope.")
    ] = False,
) -> None:
    if sql is None or len(sql) == 0 or not sql[0].strip():
        msg = (
            'query requires a SQL string as the first positional argument '
            '(e.g. `chkit query "SELECT 1"`)'
        )
        raise typer.BadParameter(msg)
    if len(sql) > 1:
        msg = (
            "query accepts a single SQL string. Wrap it in quotes if it contains spaces."
        )
        raise typer.BadParameter(msg)

    config = load_config(config_path, ChxConfigEnv(command="query"))
    if config.clickhouse is None:
        msg = (
            "No target configured. Provide a `clickhouse` block in "
            "clickhouse.config.py to run queries."
        )
        raise typer.BadParameter(msg)

    statement = sql[0]
    try:
        with ClickHouseClient.connect(config.clickhouse) as client:
            if output_json:
                payload = client.query_json(statement)
                typer.echo(format_query_json(payload))
                return
            result = client.query(statement)
            typer.echo(format_rows(result.rows))
    except typer.BadParameter:
        raise
    except Exception as error:
        cleaned = clean_query_error(error)
        raise typer.BadParameter(str(cleaned)) from cleaned
