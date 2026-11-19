"""``migrate --setting name=value`` parsing.

1:1 port of ``packages/cli/src/commands/migrate/settings.ts``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import TYPE_CHECKING

from chkit.cli.commands.migrate_errors import MigrateError
from chkit.core.sql_lexer import js_trim

if TYPE_CHECKING:
    from chkit.clickhouse.client import ClickHouseClient

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


# migrate journals a statement as completed when the server finishes it, and
# an asynchronous INSERT finishes before its rows leave the buffer unless it
# waits for the flush. chkit sends ``async_insert = 0`` and
# ``wait_for_async_insert = 1`` with every statement, so ``--setting`` may only
# repeat them, as 0 or 1, and may not name a settings profile that would apply
# over them (#790).
_DURABLE_INSERT_SETTINGS: dict[str, tuple[str, tuple[str, ...]]] = {
    "async_insert": ("0", ("0", "false")),
    "wait_for_async_insert": ("1", ("1", "true")),
}


def _durable_insert_value(name: str, value: str) -> str | None:
    if name == "profile":
        return None
    durable = _DURABLE_INSERT_SETTINGS.get(name)
    if durable is None:
        return value
    stored, spellings = durable
    return stored if value.lower() in spellings else None


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
        raw = js_trim(value)
        durable = _durable_insert_value(name, raw)
        if durable is None:
            msg = (
                f"--setting {name}={raw} is not allowed: migrate would record an "
                "asynchronous INSERT as applied while its rows may still be buffered. "
                "Nothing ran."
            )
            raise MigrateError("invalid_usage", msg)
        settings[name] = durable
    return settings


def assert_insert_settings_changeable(client: ClickHouseClient) -> None:
    """Refuse an applying run, before anything is sent, for a user whose
    settings constraints fix ``async_insert`` or ``wait_for_async_insert`` at
    another value than chkit sends: its writes could not be made to be stored
    when they return (#790). A ``readonly = 1`` user is left to the server's
    own refusal of its writes. When the settings cannot be read, the writes
    still fail closed. TS ``assertInsertSettingsChangeable``."""
    try:
        rows = client.query(
            "SELECT name, value, readonly FROM system.settings "
            "WHERE name IN ('readonly', 'async_insert', 'wait_for_async_insert')"
        ).rows
    except Exception:  # As TS: an unreadable table leaves the writes to fail closed.
        return
    by_name = {str(row["name"]): row for row in rows}
    mode = by_name.get("readonly")
    if mode is not None and str(mode["value"]) == "1":
        return
    for name, (durable, _spellings) in _DURABLE_INSERT_SETTINGS.items():
        row = by_name.get(name)
        if row is not None and str(row["readonly"]) != "0" and str(row["value"]) != durable:
            msg = insert_settings_fixed_message(name, str(row["value"]), durable)
            raise MigrateError("insert_settings_fixed", msg)


def insert_settings_fixed_message(name: str, value: str, durable: str) -> str:
    return (
        f"Setting {name} is fixed at {value} for this ClickHouse user, and chkit migrate "
        f"needs {name} = {durable} so that a statement it records as applied is stored. "
        "Nothing ran."
    )
