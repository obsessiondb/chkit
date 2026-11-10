"""Engine capabilities, matching the TypeScript core (``packages/core/src/engine.ts``)."""

from __future__ import annotations

import re
from typing import Final

from chkit.core.key_clause import split_top_level_comma
from chkit.core.sql_lexer import js_regex, js_trim

# Engines outside the MergeTree family that ClickHouse registers with
# ``supports_sort_order`` (StorageFactory), so they accept PARTITION BY,
# PRIMARY KEY, ORDER BY and SAMPLE BY. Every ``*MergeTree`` engine (plain,
# Replicated*, Shared*) supports them too. ClickHouse lists the supporting
# engines in its error when a CREATE uses them on any other engine.
_NON_MERGE_TREE_SORT_ORDER_ENGINES: Final[frozenset[str]] = frozenset(
    {
        "AzureBlobStorage",
        "COSN",
        "EmbeddedRocksDB",
        "GCS",
        "HDFS",
        "Hive",
        "Iceberg",
        "IcebergAzure",
        "IcebergHDFS",
        "IcebergLocal",
        "IcebergS3",
        "KeeperMap",
        "MaterializedPostgreSQL",
        "OSS",
        "Redis",
        "S3",
    }
)

# Distributed(cluster, database, table[, sharding_key[, policy]]): the first
# three arguments name objects, the rest are expressions.
_DISTRIBUTED_NAME_ARGUMENTS: Final[int] = 3

_ENGINE_NAME: Final[re.Pattern[str]] = re.compile(js_regex(r"^\s*([A-Za-z_][A-Za-z0-9_]*)"))
_DISTRIBUTED_ARGS: Final[re.Pattern[str]] = re.compile(
    js_regex(r"^\s*Distributed\s*\(([\s\S]*)\)\s*$")
)
_PLAIN_IDENTIFIER: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_QUOTED_IDENTIFIER: Final[re.Pattern[str]] = re.compile(r"^([`\"])((?:(?!\1).|\1\1)*)\1$")


def engine_name(engine: str) -> str:
    """The engine name without arguments: ``Distributed(c, db, t)`` -> ``Distributed``."""
    match = _ENGINE_NAME.match(engine)
    return match.group(1) if match else ""


def is_merge_tree_engine(engine: str) -> bool:
    return engine_name(engine).endswith("MergeTree")


def supports_sort_order(engine: str) -> bool:
    """Whether the engine accepts PARTITION BY / PRIMARY KEY / ORDER BY.

    Memory, Log, Null, Buffer, Merge, Distributed, Kafka and other engines
    reject them.
    """
    return (
        is_merge_tree_engine(engine)
        or engine_name(engine) in _NON_MERGE_TREE_SORT_ORDER_ENGINES
    )


_REPLICATED_ENGINE_NAME: Final[re.Pattern[str]] = re.compile(
    js_regex(r"^\s*Replicated([A-Za-z0-9_]*MergeTree)")
)
# The Keeper path and replica name lead a Replicated engine's arguments.
_REPLICATION_ARGUMENTS: Final[int] = 2
# A Keeper path or replica name that the server drops: a string literal or a
# heredoc. ObsessionDB keeps an expression path such as concat(...) as written.
_REPLICATION_ARGUMENT: Final[re.Pattern[str]] = re.compile(
    js_regex(r"^(?:'(?:[^'\\]|\\[\s\S]|'')*'|\$([A-Za-z0-9_]*)\$[\s\S]*\$\1\$)$")
)


def replicated_engine_as_shared(engine: str) -> str | None:
    """The engine a ``Replicated*MergeTree`` table has on a shared-storage server.

    ObsessionDB and ClickHouse Cloud drop the Keeper path and replica name and
    keep the other arguments, so ``ReplicatedReplacingMergeTree('/p', '{replica}', ver)``
    is stored as ``SharedReplacingMergeTree(ver)``. The result has no ``Shared``
    prefix. None for any other engine (TS ``replicatedEngineAsShared``).
    """
    match = _REPLICATED_ENGINE_NAME.match(engine)
    if match is None:
        return None
    rest = js_trim(engine[match.end() :])
    if rest and not (rest.startswith("(") and rest.endswith(")")):
        return None
    inner = rest[1:-1]
    args = split_top_level_comma(inner) if js_trim(inner) else []
    if (
        len(args) >= _REPLICATION_ARGUMENTS
        and _REPLICATION_ARGUMENT.match(args[0]) is not None
        and _REPLICATION_ARGUMENT.match(args[1]) is not None
    ):
        args = args[_REPLICATION_ARGUMENTS:]
    return f"{match.group(1)}({', '.join(args)})"


def is_distributed_engine(engine: str) -> bool:
    return engine_name(engine) == "Distributed"


def normalize_distributed_engine(engine: str) -> str:
    """Quote the cluster, database and table arguments as ClickHouse stores them.

    ``Distributed(c, db, t)`` reads back as ``Distributed('c', 'db', 't')``.
    Expressions such as ``currentDatabase()`` and the sharding key are kept as
    written.
    """
    match = _DISTRIBUTED_ARGS.match(engine)
    if match is None:
        return js_trim(engine)
    args = [
        _quote_identifier_argument(arg) if index < _DISTRIBUTED_NAME_ARGUMENTS else arg
        for index, arg in enumerate(split_top_level_comma(match.group(1)))
    ]
    return f"Distributed({', '.join(args)})"


def _quote_identifier_argument(arg: str) -> str:
    quoted = _QUOTED_IDENTIFIER.match(arg)
    if quoted is not None:
        quote = quoted.group(1)
        name = quoted.group(2).replace(quote * 2, quote)
    elif _PLAIN_IDENTIFIER.match(arg):
        name = arg
    else:
        return arg
    escaped = name.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"
