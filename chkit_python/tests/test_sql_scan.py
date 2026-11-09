"""Port of ``packages/core/src/sql-scan.test.ts`` (#200)."""

from __future__ import annotations

import json
import random
import re
from pathlib import Path
from typing import Any

import pytest

from chkit.core.key_clause import split_top_level_comma
from chkit.core.projection import normalize_projection_index
from chkit.core.sql_lexer import js_trim, tokenize_sql
from chkit.core.sql_normalizer import normalize_sql_fragment
from chkit.core.sql_scan import (
    find_matching_paren,
    find_quote_end,
    find_top_level_sql_pattern,
    is_quote_char,
    strip_wrapping_parens,
)

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/sql-scan.json").read_text(
        encoding="utf-8"
    )
)

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


def test_reads_a_paren_inside_a_heredoc_as_text() -> None:
    # #587
    assert strip_wrapping_parens("($$a)$$)") == "$$a)$$"
    assert strip_wrapping_parens("($t$(a$t$)") == "$t$(a$t$"
    # The first `(` closes right after its heredoc, not at the end.
    assert strip_wrapping_parens("($$($$) || ($$)$$)") == "($$($$) || ($$)$$)"


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


def test_ignores_parens_inside_a_heredoc_or_a_comment() -> None:
    # #587
    assert find_matching_paren("($$a)$$) tail", 0) == 7
    assert find_matching_paren("f($tag$)$tag$) tail", 1) == 13
    assert find_matching_paren("(a /* ) */) tail", 0) == 10


def test_reads_a_dollar_as_clickhouse_does_where_no_heredoc_closes() -> None:
    # No second `$$`: the `$`s are punctuation and the parens are structure.
    assert find_matching_paren("($$a) tail", 0) == 4
    # `f$$` is a name, so the later `$$` opens no heredoc.
    assert find_matching_paren("(f$$(x) || $$) tail", 0) == 13


# ---------- heredocs and comments (#596) ----------
# ``test/fixtures/sql-scan.json`` is shared with
# ``packages/core/src/sql-scan.test.ts``: both ports read a heredoc and a
# comment as text, not structure.


@pytest.mark.parametrize("case", FIXTURE["splitTopLevelComma"], ids=lambda case: case["name"])
def test_split_top_level_comma_shared_fixture(case: dict[str, Any]) -> None:
    assert split_top_level_comma(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", FIXTURE["findTopLevelSQLPattern"], ids=lambda case: case["name"])
def test_find_top_level_sql_pattern_shared_fixture(case: dict[str, Any]) -> None:
    match = find_top_level_sql_pattern(case["sql"], re.compile(case["pattern"], re.IGNORECASE))
    found = (
        None if match is None else {"index": match.start(), "length": match.end() - match.start()}
    )
    assert found == case["expected"]


@pytest.mark.parametrize("case", FIXTURE["normalizeProjectionIndex"], ids=lambda case: case["name"])
def test_normalize_projection_index_shared_fixture(case: dict[str, Any]) -> None:
    assert normalize_projection_index(case["input"]) == case["expected"]


# The scanners as they were before #596, which skipped only quotes. On input
# without heredocs and comments the lexer-based ones must agree with them.


def _legacy_split_top_level_comma(text: str) -> list[str]:
    out: list[str] = []
    current = ""
    depth = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if is_quote_char(ch):
            end = find_quote_end(text, i, ch)
            current += text[i : end + 1]
            i = end + 1
            continue
        if ch == "," and depth == 0:
            if js_trim(current):
                out.append(js_trim(current))
            current = ""
        else:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth = max(0, depth - 1)
            current += ch
        i += 1
    if js_trim(current):
        out.append(js_trim(current))
    return out


def _legacy_find_top_level_sql_pattern(sql: str, pattern: re.Pattern[str]) -> re.Match[str] | None:
    depth = 0
    i = 0
    while i < len(sql):
        char = sql[i]
        if is_quote_char(char):
            i = find_quote_end(sql, i, char) + 1
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif depth == 0:
            match = pattern.match(sql, i)
            if match is not None:
                return match
        i += 1
    return None


def _legacy_space_after_commas(text: str) -> str:
    out = ""
    i = 0
    while i < len(text):
        char = text[i]
        if is_quote_char(char):
            end = find_quote_end(text, i, char)
            out += text[i : end + 1]
            i = end + 1
            continue
        if char == ",":
            out += ", "
            if i + 1 < len(text) and text[i + 1] == " ":
                i += 1
        else:
            out += char
        i += 1
    return out


def _legacy_normalize_projection_index(index: str) -> str:
    expression = normalize_sql_fragment(index)
    stripped = strip_wrapping_parens(expression)
    while stripped != expression:
        expression = stripped
        stripped = strip_wrapping_parens(expression)
    parts = _legacy_split_top_level_comma(expression)
    if not parts:
        return ""
    if len(parts) == 1:
        return _legacy_space_after_commas(expression)
    return f"({', '.join(_legacy_normalize_projection_index(part) for part in parts)})"


# Pieces that exercise every branch of the old scanners: quotes of each kind,
# escapes, parens, commas, keywords inside and next to words, and the
# characters that start comments and heredocs (``-``, ``/``, ``*``, ``#``, ``$``).
_PIECES = [
    "SETTINGS", "settings", "xSETTINGS", "1SETTINGS", "$SETTINGS", "COMMENT", "ORDER BY", "a", "b_1",
    "1", "1.5e3", "(", ")", ",", ", ", " ", "\n", "\t", "'", '"', "`", "\\", "''", "$", "-", "/",
    "*", "#", ";", "=", ".", "é",
]  # fmt: skip


def _random_inputs(seed: int, count: int) -> list[str]:
    rng = random.Random(seed)
    inputs: list[str] = []
    while len(inputs) < count:
        text = "".join(rng.choice(_PIECES) for _ in range(rng.randrange(16)))
        has_heredoc_or_comment = any(
            token.kind in ("line_comment", "block_comment")
            or (token.kind == "string" and token.text.startswith("$"))
            for token in tokenize_sql(text)
        )
        if not has_heredoc_or_comment:
            inputs.append(text)
    return inputs


_INPUTS = _random_inputs(596, 3000)

# The legacy Python scanner had no word-start check; its patterns all start
# with \b or a delimiter, so it found the same match as TS.
_PATTERNS = [
    re.compile(r"\bSETTINGS\b", re.IGNORECASE),
    re.compile(r"\bCOMMENT\b|;", re.IGNORECASE),
    re.compile(r"\bORDER\s+BY\b", re.IGNORECASE),
]


def test_the_random_inputs_reach_the_cases_that_matter() -> None:
    counts = [
        sum(len(_legacy_split_top_level_comma(text)) > 1 for text in _INPUTS),
        sum(_legacy_find_top_level_sql_pattern(text, _PATTERNS[0]) is not None for text in _INPUTS),
        sum(re.search(r"['\"`]", text) is not None for text in _INPUTS),
        sum(re.search(r"[-/*#$]", text) is not None for text in _INPUTS),
    ]
    assert all(count > 300 for count in counts), counts


def test_split_top_level_comma_agrees_without_heredocs_or_comments() -> None:
    for text in _INPUTS:
        assert (text, split_top_level_comma(text)) == (text, _legacy_split_top_level_comma(text))


def test_find_top_level_sql_pattern_agrees_without_heredocs_or_comments() -> None:
    def span(match: re.Match[str] | None) -> tuple[int, int] | None:
        return None if match is None else match.span()

    for pattern in _PATTERNS:
        for text in _INPUTS:
            assert (text, span(find_top_level_sql_pattern(text, pattern))) == (
                text,
                span(_legacy_find_top_level_sql_pattern(text, pattern)),
            )


def test_normalize_projection_index_agrees_without_heredocs_or_comments() -> None:
    for text in _INPUTS:
        assert (text, normalize_projection_index(text)) == (
            text,
            _legacy_normalize_projection_index(text),
        )
