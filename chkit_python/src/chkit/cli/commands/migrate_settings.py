"""``migrate --setting name=value`` parsing.

1:1 port of ``packages/cli/src/commands/migrate/settings.ts``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from chkit.cli.commands.migrate_errors import MigrateError

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


def parse_setting_flags(values: Sequence[str] | None) -> dict[str, str] | None:
    """Parse ``--setting name=value`` flags into ClickHouse query settings,
    e.g. ``max_table_size_to_drop=0`` to drop a table over the server's size
    limit (#321). Like the TS ``string[]`` flag, a value may list several
    comma-separated settings. Returns None when no setting was passed."""
    entries = [
        part.strip()
        for value in values or []
        for part in value.split(",")
        if part.strip()
    ]
    if not entries:
        return None
    settings: dict[str, str] = {}
    for entry in entries:
        name, eq, value = entry.partition("=")
        name = name.strip()
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
        settings[name] = value.strip()
    return settings
