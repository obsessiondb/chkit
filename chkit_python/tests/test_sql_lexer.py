"""Port of ``packages/core/src/sql-lexer.test.ts`` (#231)."""

from __future__ import annotations

import pytest

from chkit.core.sql_lexer import (
    identifier_name,
    is_trivia,
    string_literal_value,
    tokenize_sql,
)


def kinds(sql: str) -> list[tuple[str, str]]:
    return [(token.kind, token.text) for token in tokenize_sql(sql)]


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT a.b, 'it''s', `x``y`, \"q\"\"r\" FROM db.t -- trailing\n"
        "WHERE x = 1 /* a /* b */ c */ # note\n#!shebang\n",
        "SELECT $$it's -- not a comment$$, $tag$x $$ y$tag$, 'unterminated",
        "/* unterminated block",
        "`unterminated identifier",
        "SELECT 1.5e+3, 0x1F, a$b, $x, $, \U0001d538",
        "SELECT 1 AS 1m_rollup, t.1.2, .5e3, 1_000 FROM 2024db.events // note\n",
        "SELECT 4 //2\n, 'http://x', a//*x*/b",
        "",
    ],
)
def test_is_lossless_and_offsets_are_contiguous(sql: str) -> None:
    tokens = tokenize_sql(sql)
    assert "".join(token.text for token in tokens) == sql
    offset = 0
    for token in tokens:
        assert token.start == offset
        assert token.end == offset + len(token.text)
        offset = token.end


def test_classifies_line_comments_but_not_bare_hash() -> None:
    assert kinds("a--x\nb") == [
        ("identifier", "a"),
        ("line_comment", "--x"),
        ("whitespace", "\n"),
        ("identifier", "b"),
    ]
    assert kinds("# x") == [("line_comment", "# x")]
    assert kinds("#!x") == [("line_comment", "#!x")]
    assert kinds("#x") == [("punctuation", "#"), ("identifier", "x")]


def test_reads_double_slash_as_line_comment_before_block_comment() -> None:
    assert kinds("// note") == [("line_comment", "// note")]
    assert kinds("4 //2\nx") == [
        ("number", "4"),
        ("whitespace", " "),
        ("line_comment", "//2"),
        ("whitespace", "\n"),
        ("identifier", "x"),
    ]
    assert kinds("a//*x*/b") == [("identifier", "a"), ("line_comment", "//*x*/b")]
    assert kinds("'http://x'") == [("string", "'http://x'")]
    assert kinds("4 / 2") == [
        ("number", "4"),
        ("whitespace", " "),
        ("punctuation", "/"),
        ("whitespace", " "),
        ("number", "2"),
    ]


def test_keeps_nested_block_comments_as_one_token() -> None:
    assert kinds("/* a /* b */ c */x") == [
        ("block_comment", "/* a /* b */ c */"),
        ("identifier", "x"),
    ]


def test_keeps_comment_markers_inside_strings_and_quoted_identifiers() -> None:
    assert kinds("'--' `#x` \"/*\"") == [
        ("string", "'--'"),
        ("whitespace", " "),
        ("quoted_identifier", "`#x`"),
        ("whitespace", " "),
        ("quoted_identifier", '"/*"'),
    ]


def test_handles_doubled_and_backslash_escaped_quotes() -> None:
    assert kinds("'a''b' 'c\\'d'") == [
        ("string", "'a''b'"),
        ("whitespace", " "),
        ("string", "'c\\'d'"),
    ]


def test_reads_heredocs_as_strings_only_when_closed() -> None:
    assert kinds("$$it's$$") == [("string", "$$it's$$")]
    assert kinds("$t$a$b$t$") == [("string", "$t$a$b$t$")]
    assert kinds("$abc") == [("identifier", "$abc")]
    assert kinds("a$$b$$") == [("identifier", "a$$b$$")]
    assert kinds("$$abc") == [("punctuation", "$"), ("identifier", "$abc")]
    assert kinds("$ x") == [("punctuation", "$"), ("whitespace", " "), ("identifier", "x")]


def test_reads_digit_led_run_as_name_when_word_characters_continue() -> None:
    assert kinds("app.1m_rollup") == [
        ("identifier", "app"),
        ("punctuation", "."),
        ("identifier", "1m_rollup"),
    ]
    assert kinds("2024db.events") == [
        ("identifier", "2024db"),
        ("punctuation", "."),
        ("identifier", "events"),
    ]
    for name in ["2024_events", "1e5x", "0x1G", "0b101x"]:
        assert kinds(name) == [("identifier", name)]
    # ClickHouse ends such a name at `$`: `1a$b` is `1a` followed by `$b`.
    assert kinds("1a$b") == [("identifier", "1a"), ("identifier", "$b")]


def test_keeps_numeric_literals_and_tuple_access_as_numbers() -> None:
    for literal in ["1.5e+3", "0x1F", "1_000", "0b101", "42", ".5e3"]:
        assert kinds(literal) == [("number", literal)]
    assert kinds("t.1") == [("identifier", "t"), ("punctuation", "."), ("number", "1")]
    assert kinds("t.1.2") == [
        ("identifier", "t"),
        ("punctuation", "."),
        ("number", "1"),
        ("punctuation", "."),
        ("number", "2"),
    ]
    # After a dot only digits form a number, so `1e5` there is a name.
    assert kinds("db.1e5") == [("identifier", "db"), ("punctuation", "."), ("identifier", "1e5")]
    assert kinds("1.x") == [("number", "1"), ("punctuation", "."), ("identifier", "x")]


def test_marks_unterminated_strings_identifiers_and_block_comments() -> None:
    last = tokenize_sql("x 'abc")[-1]
    assert (last.kind, last.text, last.terminated) == ("string", "'abc", False)
    last = tokenize_sql("`abc")[-1]
    assert (last.kind, last.terminated) == ("quoted_identifier", False)
    last = tokenize_sql("/* a /* b */")[-1]
    assert (last.kind, last.terminated) == ("block_comment", False)
    assert tokenize_sql("'abc'")[0].terminated is True


def test_is_trivia_covers_whitespace_and_every_comment_kind() -> None:
    significant = [t for t in tokenize_sql(" --a\n/*b*/x // c\ny # d") if not is_trivia(t)]
    assert [t.text for t in significant] == ["x", "y"]


def test_identifier_name_unquotes_identifiers() -> None:
    bare, _, backtick, _, double, _, digit_led = tokenize_sql('abc `a``b` "c""d" 1m_rollup')
    assert identifier_name(bare) == "abc"
    assert identifier_name(backtick) == "a`b"
    assert identifier_name(double) == 'c"d'
    assert identifier_name(digit_led) == "1m_rollup"


def test_identifier_name_is_none_for_non_identifiers_and_unterminated_quotes() -> None:
    assert identifier_name(tokenize_sql("'x'")[0]) is None
    assert identifier_name(tokenize_sql("`x")[0]) is None
    assert identifier_name(tokenize_sql("1_000")[0]) is None


def test_string_literal_value_unescapes_literals_and_heredocs() -> None:
    a, _, b, _, c = tokenize_sql("'it''s' 'a\\'b' $q$x'y$q$")
    assert string_literal_value(a) == "it's"
    assert string_literal_value(b) == "a'b"
    assert string_literal_value(c) == "x'y"
