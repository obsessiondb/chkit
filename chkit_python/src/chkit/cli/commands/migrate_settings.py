"""``migrate --setting name=value`` parsing.

1:1 port of ``packages/cli/src/commands/migrate/settings.ts``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from chkit.cli.commands.migrate_errors import MigrateError
from chkit.core.sql_lexer import js_trim

_SETTING_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# ClickHouse HTTP-interface parameters, not query settings: they would change
# the target database, the credentials, the query text or the query_id chkit
# tracks, so ``--setting`` rejects them (#353).
_RESERVED_NAMES = frozenset({
    "query",
    "database",
    "query_id",
    "session_id",
    "session_check",
    "session_timeout",
    "user",
    "password",
})


def _turns_on_async_insert(name: str, value: str) -> bool:
    """migrate journals a statement as completed when the server finishes it.
    An asynchronous INSERT finishes before its rows leave the buffer (with
    ``wait_for_async_insert = 0``, from the profile or another ``--setting``),
    so ``--setting async_insert`` may only turn it off (#790)."""
    return name == "async_insert" and value != "0" and value.lower() != "false"


def parse_setting_flags(values: Sequence[str] | None) -> dict[str, str] | None:
    """Parse ``--setting name=value`` flags into ClickHouse query settings,
    e.g. ``max_table_size_to_drop=0`` to drop a table over the server's size
    limit (#321). Like the TS ``string[]`` flag, a value may list several
    comma-separated settings. Returns None when no setting was passed."""
    entries = [
        js_trim(part)
        for value in values or []
        for part in value.split(",")
        if js_trim(part)
    ]
    if not entries:
        return None
    settings: dict[str, str] = {}
    for entry in entries:
        name, eq, value = entry.partition("=")
        name = js_trim(name)
        if not eq or _SETTING_NAME.fullmatch(name) is None:
            msg = (
                "--setting expects <name>=<value>, e.g. --setting "
                f"max_table_size_to_drop=0. Got: {entry}"
            )
            raise MigrateError("invalid_usage", msg)
        if name in _RESERVED_NAMES:
            msg = (
                f"--setting {name} is not allowed: {name} is a ClickHouse HTTP "
                "parameter, not a query setting."
            )
            raise MigrateError("invalid_usage", msg)
        value = js_trim(value)
        if _turns_on_async_insert(name, value):
            msg = (
                f"--setting async_insert={value} is not allowed: migrate would record an "
                "asynchronous INSERT as applied while its rows may still be buffered. "
                "Nothing ran."
            )
            raise MigrateError("invalid_usage", msg)
        settings[name] = value
    return settings
