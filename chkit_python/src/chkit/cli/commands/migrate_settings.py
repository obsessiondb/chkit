"""``migrate --setting name=value`` parsing.

1:1 port of ``packages/cli/src/commands/migrate/settings.ts``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import TYPE_CHECKING

from clickhouse_connect.driver.exceptions import (  # type: ignore[import-untyped]
    DatabaseError,
)

from chkit.cli.commands.migrate_errors import MigrateError
from chkit.clickhouse import is_unknown_database_error
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


# What every migration write sends unless ``--setting`` names it, so that a
# statement migrate journals as applied is stored (#790), each with the
# guarantee another value turns off. The client sends them after the other
# settings, so a settings profile among those cannot change them. TS
# ``INSERT_SETTING_DEFAULTS``.
_INSERT_SETTING_DEFAULTS: dict[str, tuple[str, str]] = {
    "async_insert": (
        "0", "an INSERT is queued as an asynchronous insert, which migrate cannot cancel",
    ),
    "wait_for_async_insert": (
        "1", "an asynchronous INSERT can be journaled as applied before its rows are stored",
    ),
}


def plain_setting_value(value: object) -> str:
    """A boolean setting's value in plain form, ``true`` and ``false`` as 1
    and 0. TS ``plainSettingValue``."""
    text = ("true" if value else "false") if isinstance(value, bool) else str(value).lower()
    return {"true": "1", "false": "0"}.get(text, text)


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
        settings[name] = js_trim(value)
    return settings


def insert_settings_override_warning(settings: dict[str, str] | None) -> str | None:
    """The one warning line a migrate run prints when ``--setting`` gives
    ``async_insert`` or ``wait_for_async_insert`` another value than chkit's
    default, or None (#790). TS ``insertSettingsOverrideWarning``."""
    overridden = [
        f"{name}={(settings or {})[name]} ({guarantee})"
        for name, (default, guarantee) in _INSERT_SETTING_DEFAULTS.items()
        if name in (settings or {}) and plain_setting_value((settings or {})[name]) != default
    ]
    if not overridden:
        return None
    return (
        "Warning: --setting overrides what every migration write sets by default: "
        f"{'; '.join(overridden)}."
    )


def assert_insert_settings_changeable(
    client: ClickHouseClient, settings: dict[str, str] | None = None
) -> None:
    """Refuse an applying run, before anything is sent, for a user whose
    settings constraints fix ``async_insert`` or ``wait_for_async_insert`` at
    another value than a write sends: a migration statement sends the
    ``--setting`` value if any, chkit's own journal writes chkit's default
    (#790). A ``readonly = 1`` user is left to the server's own refusal of its
    writes. A failed read stops the run, as any failed request does, except
    while the configured database does not exist yet: a run that creates it is
    then left to the server's refusal of its writes.
    TS ``assertInsertSettingsChangeable``."""
    try:
        rows = client.query(
            "SELECT name, value, readonly FROM system.settings "
            "WHERE name IN ('readonly', 'async_insert', 'wait_for_async_insert')"
        ).rows
    except DatabaseError as error:
        if is_unknown_database_error(error):
            return
        raise
    by_name = {str(row["name"]): row for row in rows}
    mode = by_name.get("readonly")
    if mode is not None and str(mode["value"]) == "1":
        return
    for name, (default, _guarantee) in _INSERT_SETTING_DEFAULTS.items():
        row = by_name.get(name)
        if row is None or str(row["readonly"]) == "0":
            continue
        fixed = str(row["value"])
        own = (settings or {}).get(name)
        if own is not None and plain_setting_value(own) != fixed:
            msg = (
                f"Setting {name} is fixed at {fixed} for this ClickHouse user, so "
                f"--setting {name}={own} cannot apply. Nothing ran."
            )
            raise MigrateError("insert_settings_fixed", msg)
        if default != fixed:
            raise MigrateError(
                "insert_settings_fixed", insert_settings_fixed_message(name, fixed, default)
            )


def insert_settings_fixed_message(name: str, value: str, durable: str) -> str:
    return (
        f"Setting {name} is fixed at {value} for this ClickHouse user, and chkit migrate "
        f"needs {name} = {durable} so that a statement it records as applied is stored. "
        "Nothing ran."
    )
