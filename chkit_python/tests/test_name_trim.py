"""Names are trimmed as TS ``String.prototype.trim`` trims them (#580).

JavaScript strips ``\\ufeff`` but keeps ``\\x1c``-``\\x1f`` and ``\\x85``, which
Python's ``str.strip`` treats the other way round. Each test mirrors a TS test
with the same input and expected output (named in its comment).
"""

from __future__ import annotations

from chkit.cli.commands.generate_rename_mappings import (
    ColumnRenameMapping,
    TableRenameMapping,
    parse_rename_column_mappings,
    parse_rename_dictionary_mappings,
    parse_rename_table_mappings,
)
from chkit.cli.commands.pull_view_parser import DependsOnEntry, parse_refresh_clause
from chkit.cli.table_scope import parse_table_selector
from chkit.clickhouse.create_dictionary_parser import (
    parse_dictionary_attributes_from_create_dictionary_query,
    parse_dictionary_primary_key_from_create_dictionary_query,
)
from chkit.clickhouse.create_table_parser import (
    parse_constraints_from_create_table_query,
    parse_projections_from_create_table_query,
)
from chkit.core.canonical import canonicalize_definitions
from chkit.core.cutover import CutoverRequest, parse_cutover_request
from chkit.core.model import (
    DictionaryDefinition,
    MaterializedViewDefinition,
    TableDefinition,
    ViewDefinition,
    dictionary,
    materialized_view,
    table,
    view,
)
from chkit.core.validate import validate_definitions


def _wrap(name: str) -> str:
    return f"﻿{name}\x85"


# TS packages/core/src/name-trim.test.ts "canonical names of every kind".
def test_canonical_names_of_every_kind_trim_javascript_whitespace() -> None:
    t, v, mv, d = canonicalize_definitions([
        table(
            database=_wrap("app"),
            name=_wrap("t"),
            renamedFrom={"database": _wrap("app"), "name": _wrap("old_t")},
            engine="MergeTree()",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": _wrap("c"), "type": "UInt64", "renamedFrom": "\x1cold_c﻿"},
            ],
            orderBy=["id"],
        ),
        view(database=_wrap("app"), name=_wrap("v"), as_="SELECT 1"),
        materialized_view(
            database=_wrap("app"),
            name=_wrap("mv"),
            to={"database": _wrap("app"), "name": _wrap("t")},
            as_="SELECT 1",
            refresh={
                "every": "1 hour",
                "dependsOn": [{"database": _wrap("app"), "name": _wrap("src")}],
            },
        ),
        dictionary(
            database=_wrap("app"),
            name=_wrap("d"),
            renamedFrom={"name": _wrap("old_d")},
            attributes=[
                {"name": _wrap("k"), "type": "UInt64"},
                {"name": "lo", "type": "Date"},
                {"name": "hi", "type": "Date"},
            ],
            primaryKey=["k\x85"],
            source="NULL()",
            layout="RANGE_HASHED()",
            lifetime="0",
            range={"min": _wrap("lo"), "max": _wrap("hi")},
        ),
    ])
    assert isinstance(t, TableDefinition)
    assert (t.database, t.name) == ("app\x85", "t\x85")
    assert t.renamed_from is not None
    assert (t.renamed_from.database, t.renamed_from.name) == ("app\x85", "old_t\x85")
    assert [(c.name, c.renamed_from) for c in t.columns] == [
        ("id", None),
        ("c\x85", "\x1cold_c"),
    ]
    assert isinstance(v, ViewDefinition)
    assert (v.database, v.name) == ("app\x85", "v\x85")
    assert isinstance(mv, MaterializedViewDefinition)
    assert (mv.database, mv.name) == ("app\x85", "mv\x85")
    assert (mv.to.database, mv.to.name) == ("app\x85", "t\x85")
    assert mv.refresh is not None
    assert mv.refresh.depends_on is not None
    assert [(r.database, r.name) for r in mv.refresh.depends_on] == [("app\x85", "src\x85")]
    assert isinstance(d, DictionaryDefinition)
    assert (d.database, d.name) == ("app\x85", "d\x85")
    assert d.renamed_from is not None
    assert d.renamed_from.name == "old_d\x85"
    assert [a.name for a in d.attributes] == ["k\x85", "lo", "hi"]
    assert d.primary_key == ["k\x85"]
    assert d.range is not None
    assert (d.range.min, d.range.max) == ("lo\x85", "hi\x85")


# TS packages/core/src/name-trim.test.ts "a column named in the engine arguments ...".
def test_an_engine_argument_keeps_a_trailing_nel() -> None:
    definition = table(
        database="app",
        name="t",
        engine="SummingMergeTree(c\x85)",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "c\x85", "type": "UInt64", "defaultKind": "EPHEMERAL"},
        ],
        orderBy=["id"],
    )
    assert [issue.code for issue in validate_definitions([definition])] == [
        "column_kind_not_stored"
    ]


# TS packages/core/src/cutover.test.ts "parseCutoverRequest" > "trims JavaScript whitespace".
def test_cutover_request_trims_javascript_whitespace() -> None:
    assert parse_cutover_request("﻿app.events﻿=﻿id\x85, \x1cuser_id") == (
        CutoverRequest("app", "events", ["id\x85", "\x1cuser_id"])
    )


# TS packages/cli/src/test/runtime/table-scope.test.ts "trims JavaScript whitespace".
def test_table_selector_trims_javascript_whitespace() -> None:
    selector = parse_table_selector("﻿analytics﻿.﻿events\x85")
    assert (selector.mode, selector.database, selector.value) == (
        "exact",
        "analytics",
        "events\x85",
    )


# TS packages/cli/src/test/commands/generate/rename-mappings.test.ts.
def test_rename_mappings_trim_javascript_whitespace() -> None:
    assert parse_rename_table_mappings(["﻿db.old\x85 = db﻿.﻿new"]) == [
        TableRenameMapping(
            old_database="db",
            old_name="old\x85",
            new_database="db",
            new_name="new",
            source="cli",
        )
    ]
    [dictionary_mapping] = parse_rename_dictionary_mappings(["db.﻿old=db.new\x85"])
    assert (dictionary_mapping.old_name, dictionary_mapping.new_name) == ("old", "new\x85")
    assert parse_rename_column_mappings(["﻿db.t.﻿old\x85=﻿new"]) == [
        ColumnRenameMapping(database="db", table="t", from_="old\x85", to="new", source="cli")
    ]


# TS packages/clickhouse/src/index-constraints-introspection.test.ts "projection and constraint names".
def test_create_table_parser_names_trim_javascript_whitespace() -> None:
    query = (
        "CREATE TABLE app.t (`id` UInt64, "
        "PROJECTION `\x85p﻿` (SELECT id ORDER BY id), "
        "PROJECTION `\x85ip﻿` INDEX id TYPE basic, "
        "CONSTRAINT `\x85c﻿` CHECK id > 0) ENGINE = MergeTree ORDER BY id"
    )
    assert [p.name for p in parse_projections_from_create_table_query(query)] == [
        "\x85p",
        "\x85ip",
    ]
    assert [c.name for c in parse_constraints_from_create_table_query(query)] == ["\x85c"]


# TS packages/clickhouse/src/index-constraints-introspection.test.ts "dictionary attribute ...".
def test_create_dictionary_parser_names_trim_javascript_whitespace() -> None:
    query = (
        "CREATE DICTIONARY app.d (`\x85k﻿` UInt64, `k2` UInt64) "
        "PRIMARY KEY k1\x85, ﻿k2 SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0)"
    )
    assert [
        a.name for a in parse_dictionary_attributes_from_create_dictionary_query(query)
    ] == ["\x85k", "k2"]
    assert parse_dictionary_primary_key_from_create_dictionary_query(query) == ["k1\x85", "k2"]


# TS packages/plugin-pull/src/index.test.ts "parseRefreshClause DEPENDS ON entries trim ...".
def test_refresh_depends_on_trims_javascript_whitespace() -> None:
    refresh = parse_refresh_clause(
        "CREATE MATERIALIZED VIEW app.mv REFRESH EVERY 1 HOUR "
        "DEPENDS ON `﻿app`.`src\x85`, `﻿other` TO app.t AS SELECT 1"
    )
    assert refresh is not None
    assert refresh.depends_on == [
        DependsOnEntry(database="app", name="src\x85"),
        DependsOnEntry(database="default", name="other"),
    ]
