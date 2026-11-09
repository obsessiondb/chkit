"""Whitespace outside names is JavaScript's, as in TS (#637).

TS trims with ``String.prototype.trim`` and matches with JS ``\\s``: those skip
``\\x1c``-``\\x1f`` and ``\\x85`` (NEL) but take ``\\ufeff`` (BOM), which Python's
``str.strip`` and ``re`` ``\\s`` treat the other way round. Each test mirrors a
TS test with the same input and expected output (named in its comment).
"""

from __future__ import annotations

import re

import pytest

from chkit.cli.commands.migrate_apply import preview_statement
from chkit.cli.commands.migrate_recovery import normalize_migration_name
from chkit.cli.commands.migrate_settings import parse_setting_flags
from chkit.cli.commands.pull_view_parser import MaterializedViewRefreshShape, parse_refresh_clause
from chkit.cli.migration_metadata import MigrationMetadata, extract_migration_metadata
from chkit.clickhouse.create_dictionary_parser import (
    ParsedDictionaryAttribute,
    parse_dictionary_attributes_from_create_dictionary_query,
    parse_dictionary_range_from_create_dictionary_query,
    parse_dictionary_settings_from_create_dictionary_query,
    parse_lifetime_from_create_dictionary_query,
)
from chkit.clickhouse.create_table_parser import (
    ProjectionDefinitionShape,
    parse_order_by_from_create_table_query,
    parse_projections_from_create_table_query,
    parse_settings_from_create_table_query,
)
from chkit.clickhouse.introspect import (
    SystemColumnRow,
    SystemSkippingIndexRow,
    normalize_column_from_system_row,
    normalize_index_from_system_row,
)
from chkit.core.canonical import canonicalize_definitions
from chkit.core.codec import parse_codec
from chkit.core.cutover import reads_table
from chkit.core.engine import engine_name
from chkit.core.flags import parse_flags
from chkit.core.kafka import is_kafka_engine
from chkit.core.model import (
    MaterializedViewDefinition,
    SkipIndexMinmax,
    dictionary,
    materialized_view,
    table,
)
from chkit.core.sql_lexer import JS_WHITESPACE, js_regex
from chkit.core.sql_normalizer import (
    is_synthetic_ephemeral_default,
    normalize_engine,
    sql_expression_fingerprint,
)
from chkit.core.sql_scan import strip_wrapping_parens
from chkit.core.validate import validate_definitions
from chkit_plugin_backfill.logging_utils import summarize_sql
from chkit_plugin_backfill.options import parse_byte_size

BOM = "\N{ZERO WIDTH NO-BREAK SPACE}"
NEL = "\x85"
FS = "\x1c"


def test_js_regex_s_is_the_javascript_whitespace_set() -> None:
    space, non_space, class_ = (
        re.compile(js_regex(pattern)) for pattern in (r"\s", r"\S", r"[^\s.]")
    )
    for char in map(chr, range(0x10000)):
        assert (space.fullmatch(char) is not None) == (char in JS_WHITESPACE), hex(ord(char))
        assert (non_space.fullmatch(char) is None) == (char in JS_WHITESPACE), hex(ord(char))
        assert (class_.fullmatch(char) is None) == (char in JS_WHITESPACE + "."), hex(ord(char))


def test_js_regex_keeps_any_char_and_other_escapes() -> None:
    assert js_regex(r"[\s\S]*") == r"[\s\S]*"
    assert js_regex(r"\\s\b\(") == r"\\s\b\("
    assert re.fullmatch(js_regex(r"a[\]\s]b"), f"a{BOM}b") is not None
    with pytest.raises(ValueError, match="inside a character class"):
        js_regex(r"[a\S]")


# TS packages/core/src/js-whitespace.test.ts "canonical refresh intervals".
def test_canonical_refresh_intervals() -> None:
    [mv] = canonicalize_definitions([
        materialized_view(
            database="app",
            name="mv",
            to={"database": "app", "name": "t"},
            as_="SELECT 1",
            refresh={"every": f"{BOM}1{BOM}{BOM}hours{NEL}", "offset": f"{FS}5{FS}minute"},
        )
    ])
    assert isinstance(mv, MaterializedViewDefinition)
    assert mv.refresh is not None
    assert (mv.refresh.every, mv.refresh.offset) == (f"1 HOUR{NEL}", f"{FS}5{FS}MINUTE")


# TS packages/core/src/js-whitespace.test.ts "engines".
def test_engines() -> None:
    assert [is_kafka_engine(f"{BOM}Kafka()"), is_kafka_engine(f"{NEL}Kafka()")] == [True, False]
    assert [engine_name(f"{BOM}MergeTree()"), engine_name(f"{FS}MergeTree()")] == ["MergeTree", ""]
    assert [
        normalize_engine(f"{BOM}SharedMergeTree{BOM}"),
        normalize_engine(f"{NEL}MergeTree"),
        normalize_engine(f"{BOM}Kafka('b:9092', {BOM}'t'{BOM})"),
        normalize_engine(f"{BOM}Distributed(c, db, t)"),
    ] == [
        "MergeTree()",
        f"{NEL}MergeTree()",
        "Kafka('b:9092', 't')",
        "Distributed('c', 'db', 't')",
    ]


# TS packages/core/src/js-whitespace.test.ts "expressions".
def test_expressions() -> None:
    assert strip_wrapping_parens(f"({BOM}a{NEL})") == f"a{NEL}"
    assert is_synthetic_ephemeral_default(f"{BOM}defaultValueOfTypeName('UInt8')")
    assert not is_synthetic_ephemeral_default(f"defaultValueOfTypeName{FS}('UInt8')")
    assert sql_expression_fingerprint(f"a{BOM}+{BOM}b") == sql_expression_fingerprint("a + b")
    assert sql_expression_fingerprint(f"a{FS}+b") != sql_expression_fingerprint("a + b")
    assert parse_codec(f"CODEC{BOM}(ZSTD(1))") == parse_codec("CODEC(ZSTD(1))")
    assert parse_codec(f"CODEC{NEL}(ZSTD(1))") != parse_codec("CODEC(ZSTD(1))")
    assert reads_table(f"SELECT * FROM app{BOM}.{BOM}t", ("app", "t"), "default")
    assert not reads_table(f"SELECT * FROM app{FS}.t", ("app", "t"), "default")


# TS packages/core/src/js-whitespace.test.ts "validation".
def test_validation() -> None:
    issues = validate_definitions([
        dictionary(
            database="app",
            name="d",
            attributes=[{"name": "k", "type": "UInt64"}],
            primaryKey=["k"],
            source=BOM,
            layout=NEL,
            lifetime="300",
        ),
        table(
            database="app",
            name="k",
            engine="Kafka()",
            columns=[{"name": "v", "type": "String"}],
            settings={
                "kafka_broker_list": BOM,
                "kafka_topic_list": NEL,
                "kafka_group_name": "g",
                "kafka_format": "JSONEachRow",
            },
        ),
        materialized_view(
            database="app",
            name="mv1",
            to={"database": "app", "name": "t"},
            as_="SELECT 1",
            refresh={"every": f"1{FS}HOUR"},
        ),
        materialized_view(
            database="app",
            name="mv2",
            to={"database": "app", "name": "t"},
            as_="SELECT 1",
            refresh={"every": f"1{BOM}HOUR"},
        ),
    ])
    assert [issue.code for issue in issues] == [
        "dictionary_missing_source",
        "kafka_missing_setting",
        "refresh_interval_format",
    ]
    assert "kafka_broker_list" in issues[1].message
    assert "app.mv1" in issues[2].message


# TS packages/clickhouse/src/js-whitespace.test.ts "SHOW CREATE DICTIONARY".
def test_show_create_dictionary() -> None:
    query = (
        f"CREATE DICTIONARY app.d (`k` UInt64,{FS}`v` String{NEL}DEFAULT 'x') PRIMARY KEY k "
        f"SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME({BOM}MIN 0 MAX 10{FS}) "
        f"RANGE(MIN{BOM}lo MAX hi) SETTINGS({BOM}max_threads = 1)"
    )
    assert parse_dictionary_attributes_from_create_dictionary_query(query) == [
        ParsedDictionaryAttribute(name="k", type="UInt64")
    ]
    assert parse_lifetime_from_create_dictionary_query(query) == f"MIN 0 MAX 10{FS}"
    assert parse_dictionary_range_from_create_dictionary_query(query) == ("lo", "hi")
    assert parse_dictionary_settings_from_create_dictionary_query(query) == {"max_threads": 1}


# TS packages/clickhouse/src/js-whitespace.test.ts "SHOW CREATE TABLE".
def test_show_create_table() -> None:
    query = (
        f"CREATE TABLE app.t (`id` UInt64, PROJECTION{BOM}p (SELECT id ORDER BY id))"
        f"{BOM}ENGINE = MergeTree ORDER BY{BOM}id SETTINGS{BOM}index_granularity = 8192{BOM}"
    )
    assert parse_projections_from_create_table_query(query) == [
        ProjectionDefinitionShape(name="p", query="SELECT id ORDER BY id")
    ]
    assert parse_order_by_from_create_table_query(query) == "id"
    assert parse_settings_from_create_table_query(query) == {"index_granularity": "8192"}


# TS packages/clickhouse/src/js-whitespace.test.ts "system tables".
def test_system_tables() -> None:
    column = normalize_column_from_system_row(
        SystemColumnRow(
            database="app",
            table="t",
            name="c",
            type="UInt8",
            position=1,
            default_kind="DEFAULT",
            default_expression=f"{BOM}1{NEL}",
            comment=f"{BOM}hi{NEL}",
        )
    )
    assert (column.default, column.comment) == (f"1{NEL}", f"hi{NEL}")
    index = normalize_index_from_system_row(
        SystemSkippingIndexRow(
            database="app", table="t", name="i", type=f"minmax{BOM}", expr="c", granularity=1
        )
    )
    assert isinstance(index, SkipIndexMinmax)


# TS packages/plugin-pull/src/js-whitespace.test.ts "REFRESH separated by JavaScript whitespace".
def test_pulled_refresh_clause() -> None:
    query = (
        f"CREATE MATERIALIZED VIEW db.mv REFRESH{BOM}EVERY{BOM}1{BOM}HOUR{NEL} "
        "TO db.t AS SELECT 1"
    )
    assert parse_refresh_clause(query) == MaterializedViewRefreshShape(every="1 HOUR")


# TS packages/cli/src/test/js-whitespace.test.ts "migrate inputs".
def test_migrate_inputs() -> None:
    assert preview_statement(f"{BOM}SELECT{FS}1{BOM}") == f"SELECT{FS}1"
    assert parse_setting_flags([f"{BOM}max_threads={BOM}2{NEL}"]) == {"max_threads": f"2{NEL}"}
    assert extract_migration_metadata(f"{BOM}-- log:{BOM}hello{NEL}\nSELECT 1") == (
        MigrationMetadata(log=f"hello{NEL}")
    )
    assert normalize_migration_name(f"{BOM}20260101_x{NEL}", "--retry") == f"20260101_x{NEL}.sql"


# TS packages/core/src/js-whitespace.test.ts "string[] flag values".
def test_string_list_flag_values() -> None:
    flags = parse_flags(["--table", f"{BOM}a,{NEL}b"], [{"name": "--table", "type": "string[]"}])
    assert flags == {"--table": ["a", f"{NEL}b"]}


# TS packages/plugin-backfill/src/js-whitespace.test.ts "options and SQL summaries".
def test_backfill_options_and_sql_summaries() -> None:
    assert parse_byte_size(f"{BOM}10{BOM}M") == 10 * 1024**2
    assert summarize_sql(f"{BOM}SELECT{FS}1{BOM}") == f"SELECT{FS}1"
