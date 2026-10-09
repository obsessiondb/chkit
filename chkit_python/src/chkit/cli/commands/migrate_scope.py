"""Filter pending migrations by ``--table`` scope.

1:1 port of ``packages/cli/src/commands/migrate/scope.ts``.

TS pulls operation summaries from the full ``safety-markers.ts``
parser. Until that ports, we use the minimal subset needed for scope
filtering: the ``-- operation: <type> key=<key> risk=<risk>`` line
emitted by ``migration_store.write_migration``. The same regex would
fall out of the safety-markers parser anyway.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from chkit.cli.table_scope import (
    database_key_from_operation_key,
    table_key_from_operation_key,
)

_OPERATION_LINE = re.compile(
    r"^--\s*operation:\s*(?P<type>\S+)\s+key=(?P<key>\S+)(?:\s+risk=(?P<risk>\S+))?",
    re.MULTILINE,
)


@dataclass(frozen=True, slots=True)
class ScopeFilterResult:
    """Result of filtering pending migrations by ``--table`` scope."""

    in_scope: list[str]
    """Migrations to apply under the scope (matched + fail-safe-included)."""

    undetermined: list[str]
    """Migrations included because their target tables can't be parsed."""


def _extract_operation_keys(sql: str) -> list[str]:
    return [match.group("key") for match in _OPERATION_LINE.finditer(sql)]


def filter_pending_by_scope(
    migrations_dir: Path,
    pending: list[str],
    selected_tables: frozenset[str] | set[str],
) -> ScopeFilterResult:
    """Keep pending migrations whose ``-- operation:`` keys touch a selected table.

    A migration with NO parseable operation markers (hand-written, no
    chkit header) is included with a record in ``undetermined`` — so the
    caller can warn rather than silently skip them (the TS gap #36).
    """
    selected_databases = {key.split(".", 1)[0] for key in selected_tables}

    in_scope: list[str] = []
    undetermined: list[str] = []

    for file in pending:
        sql = (migrations_dir / file).read_text(encoding="utf-8")
        operation_keys = _extract_operation_keys(sql)

        if not operation_keys:
            in_scope.append(file)
            undetermined.append(file)
            continue

        matches = False
        for op_key in operation_keys:
            target_table = table_key_from_operation_key(op_key)
            if target_table is not None and target_table in selected_tables:
                matches = True
                break
            target_database = database_key_from_operation_key(op_key)
            if target_database is not None and target_database in selected_databases:
                matches = True
                break

        if matches:
            in_scope.append(file)

    return ScopeFilterResult(in_scope=in_scope, undetermined=undetermined)
