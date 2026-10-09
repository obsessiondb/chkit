"""Port of ``packages/core/src/sql-scan.test.ts`` (#200)."""

from __future__ import annotations

from chkit.core.key_clause import split_top_level_comma
from chkit.core.sql_scan import find_matching_paren, find_quote_end, strip_wrapping_parens

# ---------- split_top_level_comma ----------


def test_splits_only_at_top_level_commas() -> None:
    assert split_top_level_comma("a, b, c") == ["a", "b", "c"]
    assert split_top_level_comma("cityHash64(a, b), c") == ["cityHash64(a, b)", "c"]


def test_ignores_commas_and_parens_inside_quotes_of_every_kind() -> None:
    assert split_top_level_comma("'x,y', z") == ["'x,y'", "z"]
    assert split_top_level_comma('"x,y", z') == ['"x,y"', "z"]
    assert split_top_level_comma("`a,b`, c") == ["`a,b`", "c"]
    assert split_top_level_comma("`a)b`, c") == ["`a)b`", "c"]


def test_honours_backslash_escapes_and_doubled_quotes() -> None:
    assert split_top_level_comma("'a\\\\', b") == ["'a\\\\'", "b"]
    assert split_top_level_comma("'it''s, ok', b") == ["'it''s, ok'", "b"]


# ---------- strip_wrapping_parens ----------


def test_peels_exactly_one_wrapping_layer_and_only_a_genuine_wrapper() -> None:
    assert strip_wrapping_parens("(a, b)") == "a, b"
    assert strip_wrapping_parens("((a, b))") == "(a, b)"
    assert strip_wrapping_parens("(a), (b)") == "(a), (b)"
    assert strip_wrapping_parens("a, b") == "a, b"


def test_is_not_fooled_by_a_paren_inside_a_backtick_identifier() -> None:
    assert strip_wrapping_parens("(`w)x`)") == "`w)x`"
    assert strip_wrapping_parens("(`w)x`, a)") == "`w)x`, a"


def test_is_not_fooled_by_an_escaped_backslash_before_a_closing_quote() -> None:
    assert strip_wrapping_parens("('a\\\\', ')')") == "'a\\\\', ')'"


# ---------- find_quote_end ----------


def test_returns_the_index_of_the_closing_quote() -> None:
    assert find_quote_end("'abc' tail", 0, "'") == 4
    assert find_quote_end("'a\\'b' tail", 0, "'") == 5
    assert find_quote_end("'a''b' tail", 0, "'") == 5
    assert find_quote_end("`a``b` tail", 0, "`") == 5


def test_a_backslash_escaped_backslash_does_not_escape_the_closing_quote() -> None:
    assert find_quote_end("'a\\\\' tail", 0, "'") == 4


def test_runs_to_the_end_of_unterminated_input() -> None:
    assert find_quote_end("'abc", 0, "'") == 4


# ---------- find_matching_paren ----------


def test_finds_the_close_matching_the_open_at_the_given_index() -> None:
    assert find_matching_paren("(a, b) rest", 0) == 5
    assert find_matching_paren("f(g(x)) rest", 1) == 6


def test_ignores_parens_inside_quotes() -> None:
    # The ')' inside the quoted region must not close the group.
    assert find_matching_paren("(`w)x`) tail", 0) == 6
    assert find_matching_paren("('a)b') tail", 0) == 6


def test_returns_none_when_unbalanced() -> None:
    assert find_matching_paren("(a, b", 0) is None
