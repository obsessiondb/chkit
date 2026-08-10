"""1:1 port of ``packages/plugin-backfill/src/chunking/sql.test.ts``.

Covers the shared SQL scanner primitives (``find_top_level_keywords``,
``split_top_level``), materialized-view query rewriting
(``rewrite_select_columns``, ``extract_source_table_ref``) and sort-key
filter injection (``inject_sort_key_filter``).
"""

from __future__ import annotations

from chkit_plugin_backfill.chunking.sql import (
    extract_source_table_ref,
    find_top_level_keywords,
    inject_sort_key_filter,
    rewrite_select_columns,
    split_top_level,
)

# ── find_top_level_keywords ──────────────────────────────────────────────────


def test_finds_keywords_at_the_top_level_in_ascending_position_order() -> None:
    hits = find_top_level_keywords("SELECT a FROM t", ["SELECT", "FROM"])
    assert hits == [("SELECT", 0), ("FROM", 9)]


def test_ignores_keywords_nested_inside_parentheses() -> None:
    hits = find_top_level_keywords(
        "SELECT a, (SELECT b FROM sub) AS x FROM main", ["SELECT", "FROM"]
    )
    assert len([hit for hit in hits if hit[0] == "SELECT"]) == 1
    assert len([hit for hit in hits if hit[0] == "FROM"]) == 1


def test_ignores_keywords_inside_single_quoted_string_literals() -> None:
    hits = find_top_level_keywords("SELECT 'FROM WHERE' FROM t", ["FROM", "WHERE"])
    assert len(hits) == 1
    assert hits[0][0] == "FROM"


def test_treats_a_backslash_escaped_quote_as_still_inside_the_string() -> None:
    # The escaped quote does not close the literal, so the WHERE inside it is skipped.
    hits = find_top_level_keywords("SELECT 'a\\' WHERE b' AS c FROM t", ["WHERE", "FROM"])
    assert [hit[0] for hit in hits] == ["FROM"]


def test_requires_a_word_boundary_so_substrings_do_not_match() -> None:
    assert find_top_level_keywords("SELECTED FROM t", ["SELECT"]) == []
    assert find_top_level_keywords("a.WHERE = 1", ["WHERE"]) == []


def test_matches_case_insensitively() -> None:
    hits = find_top_level_keywords("select a from t", ["SELECT", "FROM"])
    assert [hit[0] for hit in hits] == ["SELECT", "FROM"]


def test_matches_multi_word_keywords_like_group_by() -> None:
    hits = find_top_level_keywords("SELECT * FROM t GROUP BY g", ["GROUP BY"])
    assert len(hits) == 1
    assert hits[0][0] == "GROUP BY"


# ── split_top_level ──────────────────────────────────────────────────────────


def test_splits_on_top_level_delimiters() -> None:
    assert [s.strip() for s in split_top_level("a, b, c", ",")] == ["a", "b", "c"]


def test_does_not_split_inside_parentheses() -> None:
    assert [s.strip() for s in split_top_level("a, f(b, c), d", ",")] == [
        "a",
        "f(b, c)",
        "d",
    ]


def test_does_not_split_inside_string_literals() -> None:
    assert [s.strip() for s in split_top_level("a, 'x, y', b", ",")] == ["a", "'x, y'", "b"]


def test_keeps_a_backslash_escaped_quote_inside_the_literal() -> None:
    segments = split_top_level("'a\\', b', c", ",")
    assert len(segments) == 2
    assert segments[0].strip() == "'a\\', b'"
    assert segments[1].strip() == "c"


def test_returns_the_whole_string_when_no_delimiter_is_present() -> None:
    assert split_top_level("a b c", ",") == ["a b c"]


# ── rewrite_select_columns ───────────────────────────────────────────────────


def test_reorders_projection_items_to_match_target_column_order() -> None:
    rewritten = rewrite_select_columns("SELECT a AS x, b AS y FROM t", ["y", "x"])
    assert "SELECT b AS y, a AS x" in rewritten
    assert "FROM t" in rewritten


def test_does_not_confuse_select_from_keywords_inside_string_literals() -> None:
    rewritten = rewrite_select_columns(
        "SELECT 'has FROM inside' AS note, id FROM t",
        ["id", "note"],
    )
    assert "id, 'has FROM inside' AS note" in rewritten
    assert "FROM t" in rewritten


def test_handles_backslash_escaped_quotes_with_commas_inside_a_projection_item() -> None:
    rewritten = rewrite_select_columns("SELECT 'a\\', b' AS label, id FROM t", ["id", "label"])
    assert "id, 'a\\', b' AS label" in rewritten
    assert "FROM t" in rewritten


def test_keeps_a_nested_paren_subquery_projection_item_intact() -> None:
    rewritten = rewrite_select_columns(
        "SELECT id, (SELECT max(v) FROM sub WHERE k = a) AS mx FROM main",
        ["mx", "id"],
    )
    assert "(SELECT max(v) FROM sub WHERE k = a) AS mx, id" in rewritten
    assert "FROM main" in rewritten


def test_preserves_trailing_clauses_after_from() -> None:
    rewritten = rewrite_select_columns(
        "SELECT a AS x, b FROM t WHERE c = 1 GROUP BY d",
        ["b", "x"],
    )
    assert "SELECT b, a AS x" in rewritten
    assert "FROM t WHERE c = 1 GROUP BY d" in rewritten


def test_falls_through_unmatched_target_columns_as_bare_column_references() -> None:
    rewritten = rewrite_select_columns("SELECT event_time AS ts FROM t", ["ts", "ingested_at"])
    assert "SELECT event_time AS ts, ingested_at" in rewritten


def test_returns_the_query_unchanged_when_from_is_missing() -> None:
    assert rewrite_select_columns("SELECT a, b", ["b", "a"]) == "SELECT a, b"


def test_returns_the_query_unchanged_when_select_is_missing() -> None:
    assert rewrite_select_columns("DELETE FROM t", ["a"]) == "DELETE FROM t"


def test_preserves_a_leading_distinct() -> None:
    rewritten = rewrite_select_columns("SELECT DISTINCT a AS x, b AS y FROM t", ["y", "x"])
    assert "SELECT DISTINCT b AS y, a AS x" in rewritten


# ── extract_source_table_ref ─────────────────────────────────────────────────


def test_extracts_a_qualified_database_table() -> None:
    assert extract_source_table_ref("SELECT * FROM solana.raw_token_transfers") == {
        "database": "solana",
        "table": "raw_token_transfers",
    }


def test_stops_at_a_trailing_clause() -> None:
    assert extract_source_table_ref(
        "SELECT a, count() AS c FROM app.events GROUP BY a ORDER BY c"
    ) == {"database": "app", "table": "events"}


def test_ignores_a_table_alias() -> None:
    assert extract_source_table_ref("SELECT * FROM app.events AS e WHERE e.x = 1") == {
        "database": "app",
        "table": "events",
    }
    assert extract_source_table_ref("SELECT * FROM app.events e") == {
        "database": "app",
        "table": "events",
    }


def test_returns_a_bare_table_with_no_database() -> None:
    assert extract_source_table_ref("SELECT count() FROM raw_events") == {"table": "raw_events"}


def test_strips_backtick_quoted_identifiers() -> None:
    assert extract_source_table_ref("SELECT * FROM `app`.`events`") == {
        "database": "app",
        "table": "events",
    }


def test_ignores_a_from_keyword_hiding_inside_a_string_literal() -> None:
    assert extract_source_table_ref("SELECT 'FROM sneaky' AS note FROM app.events") == {
        "database": "app",
        "table": "events",
    }


def test_returns_none_for_a_subquery_source() -> None:
    assert extract_source_table_ref("SELECT * FROM (SELECT * FROM app.events) AS s") is None


def test_returns_none_for_a_table_function_source() -> None:
    assert extract_source_table_ref("SELECT * FROM numbers(10)") is None


def test_returns_none_when_there_is_no_from() -> None:
    assert extract_source_table_ref("SELECT 1") is None


# ── inject_sort_key_filter ───────────────────────────────────────────────────


def test_adds_a_where_clause_when_none_exists() -> None:
    sql = inject_sort_key_filter("SELECT * FROM t", "ts", "numeric", "1", "5")
    assert "WHERE ts >= '1'" in sql
    assert "AND ts < '5'" in sql


def test_appends_with_and_when_a_where_already_exists() -> None:
    sql = inject_sort_key_filter("SELECT * FROM t WHERE x = 1", "ts", "numeric", "1", "5")
    assert "WHERE x = 1" in sql
    assert "AND ts >= '1'" in sql


def test_inserts_the_filter_before_a_trailing_clause() -> None:
    sql = inject_sort_key_filter("SELECT * FROM t GROUP BY g", "ts", "numeric", "1", "5")
    assert sql.index("WHERE ts") < sql.index("GROUP BY g")
    assert "GROUP BY g" in sql


def test_ignores_a_trailing_clause_keyword_that_lives_inside_a_string_literal() -> None:
    sql = inject_sort_key_filter(
        "SELECT * FROM t WHERE label = 'GROUP BY hack'",
        "ts",
        "numeric",
        "1",
        "5",
    )
    assert "label = 'GROUP BY hack'" in sql
    assert "AND ts >= '1'" in sql
    # No fresh WHERE was inserted; the existing one was extended.
    assert sql.count("WHERE") == 1
