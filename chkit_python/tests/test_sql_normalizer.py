"""Tests for `chkit.core.sql_normalizer` (port of ``sql-normalizer.test.ts``, #232/#234)."""

from __future__ import annotations

import json
from collections.abc import Callable

import pytest

from chkit.core.sql_lexer import JS_WHITESPACE_RUN, is_js_space, is_trivia, js_trim, tokenize_sql
from chkit.core.sql_normalizer import (
    is_synthetic_ephemeral_default,
    normalize_sql_fragment,
    sql_expression_fingerprint,
    strip_sql_comments,
)

# The view SQL from issue #232: a `--` comment with an apostrophe between CTEs.
ISSUE_AS = "\n".join([
    "WITH people_by_email AS (SELECT person_id, company_id, arrayJoin(emails) AS email "
    "FROM brain.person_identity),",
    "-- The attendee's company: through their person record, else through the email domain.",
    "meeting_company AS (",
    "  SELECT email, company_id FROM people_by_email",
    ")",
    "SELECT email, company_id FROM meeting_company",
])

CASES: list[tuple[str, str, str]] = [
    ("issue #232: a -- comment with an apostrophe between CTEs", ISSUE_AS,
     "WITH people_by_email AS (SELECT person_id, company_id, arrayJoin(emails) AS email FROM "
     "brain.person_identity), meeting_company AS ( SELECT email, company_id FROM people_by_email "
     ") SELECT email, company_id FROM meeting_company"),
    ("trailing line comment", "SELECT 1 AS x\n-- trailing", "SELECT 1 AS x"),
    ("line comment at the end of input", "SELECT 1 AS x -- note", "SELECT 1 AS x"),
    ("-- without a space", "SELECT 1 AS x --x\n, 2 AS y", "SELECT 1 AS x , 2 AS y"),
    ("-- right after a number", "SELECT 1--2\n AS x", "SELECT 1 AS x"),
    ("# followed by a space", "SELECT 1 AS x # note\n, 2 AS y", "SELECT 1 AS x , 2 AS y"),
    ("#! comment", "SELECT 1 AS x #!note\n, 2 AS y", "SELECT 1 AS x , 2 AS y"),
    ("// comment", "SELECT 1 AS x // note\n, 2 AS y", "SELECT 1 AS x , 2 AS y"),
    ("// right before digits", "SELECT 4 //2\n AS x", "SELECT 4 AS x"),
    ("// takes precedence over /*", "SELECT 1 AS a//*x*/b\n, 2 AS c", "SELECT 1 AS a , 2 AS c"),
    ("block comment", "SELECT /* note */ 1 AS x", "SELECT 1 AS x"),
    ("nested block comment", "SELECT /* a /* b */ c */ 1 AS x", "SELECT 1 AS x"),
    ("multi-line block comment holding --", "SELECT 1 /* -- x\n y */ AS x", "SELECT 1 AS x"),
    ("a removed comment still separates tokens", "SELECT a/*x*/,b FROM t", "SELECT a ,b FROM t"),
    ("removing a comment never forms --", "SELECT 3 -/**/-1 AS z", "SELECT 3 - -1 AS z"),
    ("line comment containing /*", "SELECT 1 -- a /* b\nAS x", "SELECT 1 AS x"),
    ("line comment containing */", "SELECT 1 -- a */ b\nAS x", "SELECT 1 AS x"),
    ("apostrophe inside a block comment", "SELECT /* it's */ 1 AS x", "SELECT 1 AS x"),
    ("comment markers inside a string literal are text",
     "SELECT 'a -- b # c // d /* e */' AS s", "SELECT 'a -- b # c // d /* e */' AS s"),
    ("a URL literal is text", "SELECT 'https://x.io/a' AS u", "SELECT 'https://x.io/a' AS u"),
    ("escaped quotes keep the literal open",
     "SELECT 'it''s -- x', 'it\\'s -- y' AS s -- note", "SELECT 'it''s -- x', 'it\\'s -- y' AS s"),
    ("comment markers inside quoted identifiers are text",
     'SELECT 1 AS `a--b#c/*d*/`, 2 AS "x -- y"', 'SELECT 1 AS `a--b#c/*d*/`, 2 AS "x -- y"'),
    ("a heredoc is a literal",
     "SELECT $q$it's -- not # a /* comment $q$ AS h -- real\n, 2 AS y",
     "SELECT $q$it's -- not # a /* comment $q$ AS h , 2 AS y"),
    ("$ inside a name does not open a heredoc", "SELECT 1 AS x$ -- $x\n", "SELECT 1 AS x$"),
    ("CRLF line endings", "SELECT 1 AS x\r\n-- note\r\n, 2 AS y", "SELECT 1 AS x , 2 AS y"),
    # ClickHouse ends a line comment at \n only.
    ("a lone CR does not end a line comment", "SELECT 1 AS x -- note\r, 2 AS y", "SELECT 1 AS x"),
    ("an unterminated block comment is kept for ClickHouse to report",
     "SELECT 1 /* never\n closed", "SELECT 1 /* never closed"),
    ("an unterminated string is kept for ClickHouse to report",
     "SELECT 'abc -- x\n FROM t", "SELECT 'abc -- x FROM t"),
    ("comment-only fragment", "-- nothing here\n/* or here */", ""),
    ("comment-free text collapses whitespace as before",
     "  SELECT\n\tid,\n  email\nFROM   app.users  ", "SELECT id, email FROM app.users"),
    ("Unicode whitespace collapses as before", "SELECT\u00a01\u2028AS x", "SELECT 1 AS x"),
    # Kept on purpose: preserving it would change existing snapshots (follow-up).
    ("whitespace inside a string literal still collapses", "SELECT 'a  b' AS s", "SELECT 'a b' AS s"),
    ("# followed by a letter is not a comment", "SELECT 1 AS x #note", "SELECT 1 AS x #note"),
    # `#` not followed by a space or `!` is a ClickHouse syntax error. A
    # collapsed space after it would make it a `# ` comment that hides the rest.
    ("a bare # on its own line stays a syntax error instead of hiding the next line",
     "SELECT 1 AS x\n#\n, 2 AS y", "SELECT 1 AS x #\n, 2 AS y"),
    ("a bare # before a tab stays a syntax error", "SELECT 1 #\tx", "SELECT 1 #\nx"),
    ("a bare # before a removed comment stays a syntax error", "SELECT 1 #/* c */x", "SELECT 1 #\nx"),
    ("a bare # before a no-break space stays a syntax error", "SELECT 1 #\u00a0x", "SELECT 1 #\nx"),
]

RANDOM_ATOMS = [
    "--", "//", "/*", "*/", "# ", "#!", "#", "$q$", "$$", "''", "e-", "db.t",
    "a", "b", "e", "x", "1", "0", ".", "_", "!", "-", "/", "*", "\\", "(", ")", ",", ";", "+", "$",
    "'", '"', "`", " ", " ", "\n", "\t", "\r", "\u00a0", "\u2028",
]

# Column default expressions (#234): comments go, everything else stays.
STRIP_CASES: list[tuple[str, str, str]] = [
    ("a trailing -- comment", "now() -- set on insert", "now()"),
    ("a nested block comment", "now() /* a /* nested */ b */ + 1", "now() + 1"),
    ("a # comment", "toUInt8(1) # one", "toUInt8(1)"),
    ("#! and // comments before a newline", "x #! note\n+ y // more\n+ 1", "x + y + 1"),
    ("comment markers inside literals, quoted identifiers and heredocs",
     "concat('a -- b', `c--d`, \"#e\", $$ /* f */ $$)",
     "concat('a -- b', `c--d`, \"#e\", $$ /* f */ $$)"),
    ("whitespace inside literals", "concat('x  y', 'a\n  b')", "concat('x  y', 'a\n  b')"),
    ("whitespace outside literals that holds no comment",
     "multiIf(\n  a = 1, 2, -- one\n  3)", "multiIf(\n  a = 1, 2, 3)"),
    ("tokens around a comment stay apart", "1 -/**/-1", "1 - -1"),
    ("a stray # before a comment keeps its error", "#/* c */x", "#\nx"),
    # Whatever chkit renders after the expression must not turn the # into a `# ` comment.
    ("a stray # at the end keeps its error", "now() #", "now() #\n"),
    ("a stray # before a final comment keeps its error", "now() #\t-- c", "now() #\n"),
    ("a stray # before trailing Unicode whitespace keeps its error", "now() #\u00a0", "now() #\n"),
    ("an unterminated block comment", "now() /* oops", "now() /* oops"),
    ("only comments", " -- nothing\n/* here */ ", ""),
]


@pytest.mark.parametrize(("name", "value", "expected"), CASES, ids=[c[0] for c in CASES])
def test_normalize_sql_fragment(name: str, value: str, expected: str) -> None:
    assert normalize_sql_fragment(value) == expected


def test_normalize_sql_fragment_is_idempotent() -> None:
    generated = _random_inputs(20_000, 232)
    assert len(set(generated)) > 15_000
    inputs = [c[1] for c in CASES] + generated
    unstable = [
        value for value in inputs
        if normalize_sql_fragment(normalize_sql_fragment(value)) != normalize_sql_fragment(value)
    ]
    assert unstable == []


def test_normalize_sql_fragment_never_drops_sql_text_and_leaves_no_comment() -> None:
    generated = _random_inputs(20_000, 7)
    assert len(set(generated)) > 15_000
    inputs = [c[1] for c in CASES] + generated
    damaged = [
        value for value in inputs
        if _significant_text(normalize_sql_fragment(value)) != _significant_text(value)
        or _has_closed_comment(normalize_sql_fragment(value))
    ]
    assert damaged == []


def test_normalize_sql_fragment_matches_whitespace_collapse_without_comments() -> None:
    # The generator, not the code under test, guarantees there is nothing to
    # strip: comment markers and `#` only ever appear inside literals.
    generated = _comment_free_inputs(5_000, 31)
    assert len(set(generated)) > 4_000
    changed = [
        value for value in generated
        if normalize_sql_fragment(value) != js_trim(JS_WHITESPACE_RUN.sub(" ", value))
    ]
    assert changed == []


@pytest.mark.parametrize(("name", "value", "expected"), STRIP_CASES, ids=[c[0] for c in STRIP_CASES])
def test_strip_sql_comments(name: str, value: str, expected: str) -> None:
    assert strip_sql_comments(value) == expected


def test_strip_sql_comments_never_drops_text_and_is_idempotent() -> None:
    generated = _random_inputs(20_000, 234)
    assert len(set(generated)) > 15_000
    inputs = [c[1] for c in STRIP_CASES] + generated
    damaged = []
    for value in inputs:
        stripped = strip_sql_comments(value)
        if (
            _significant_text(stripped) != _significant_text(value)
            or _has_closed_comment(stripped)
            or strip_sql_comments(stripped) != stripped
        ):
            damaged.append(value)
    assert damaged == []


def test_strip_sql_comments_only_trims_sql_without_comments() -> None:
    generated = _comment_free_inputs(5_000, 34)
    assert len(set(generated)) > 4_000
    assert [value for value in generated if strip_sql_comments(value) != js_trim(value)] == []


def test_unlexable_expressions_fall_back_to_normalized_text() -> None:
    for value in ["$$it's", "concat(a", "a; b", "/* open", "'\\xZZ'"]:
        assert sql_expression_fingerprint(value) == json.dumps(value)
    assert sql_expression_fingerprint("concat(a;\n  x)") == sql_expression_fingerprint(
        " concat(a; x) "
    )
    # The fallback drops comments, not only whitespace.
    assert sql_expression_fingerprint("concat(a -- note\n, b") == json.dumps("concat(a , b")
    assert sql_expression_fingerprint("concat(a") != sql_expression_fingerprint("concat(a)")


def test_heredocs_fingerprint_like_the_literal_clickhouse_stores_for_them() -> None:
    # Pairs observed on ClickHouse 26.3.
    for heredoc, stored in [
        ("$$it's$$", "'it\\'s'"),
        ("$tag$a'b$tag$", "'a\\'b'"),
        ("concat($$(x$$,'y')", "concat('(x', 'y')"),
        ("$$a\\nb$$", "'a\\\\nb'"),
        ("$$é\\$$", "'é\\\\'"),
        ("$a$$$a$", "'$'"),
        ("$$$$", "''"),
    ]:
        assert sql_expression_fingerprint(heredoc) == sql_expression_fingerprint(stored), heredoc
    assert sql_expression_fingerprint("$$it's$$") != sql_expression_fingerprint("$$its'$$")
    # A dollar sign inside a word is part of the identifier, not a heredoc.
    assert sql_expression_fingerprint("x$$a$$") == json.dumps(["x$$a$$"])


def test_is_synthetic_ephemeral_default_accepts_one_default_value_of_type_name_literal() -> None:
    for expression in [
        "defaultValueOfTypeName('BIGINT')",
        "defaultValueOfTypeName( 'Decimal32(2)' )",
        "defaultValueOfTypeName('Enum8(\\'a\\\\b\\' = 1)')",
    ]:
        assert is_synthetic_ephemeral_default(expression), expression
    for expression in ["defaultValueOfTypeName('String') || 'x'", "defaultValueOfTypeName('a', 'b')"]:
        assert not is_synthetic_ephemeral_default(expression), expression


# Seeded so a failure reproduces: mulberry32, as in the TS test.
def _create_random(seed: int) -> Callable[[], float]:
    state = seed & 0xFFFFFFFF

    def imul(a: int, b: int) -> int:
        return (a * b) & 0xFFFFFFFF

    def next_value() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = imul(state ^ (state >> 15), state | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return next_value


def _random_inputs(count: int, seed: int) -> list[str]:
    random = _create_random(seed)

    def pick(items: list[str]) -> str:
        return items[int(random() * len(items))]

    return ["".join(pick(RANDOM_ATOMS) for _ in range(int(random() * 25))) for _ in range(count)]


def _comment_free_inputs(count: int, seed: int) -> list[str]:
    # SQL with comment markers only inside string literals, quoted identifiers
    # and heredocs. Whitespace follows every `-` and `/`, so no `--`, `//` or
    # `/*` forms outside them, and `#` never appears outside them.
    random = _create_random(seed)

    def pick(items: list[str]) -> str:
        return items[int(random() * len(items))]

    def literal_body() -> str:
        return "".join(
            pick(["a", " ", "  ", "\n", "\t", "\u00a0", "--", "//", "/*", "*/", "#", "# ", "#!",
                  ";", "$"])
            for _ in range(int(random() * 6))
        )

    pieces: list[Callable[[], str]] = [
        lambda: pick(["SELECT", "FROM", "a", "b_1", "x$", "1", "2.5", "1e-3", "count", "db.t"]),
        lambda: pick(["(", ")", ",", ".", "+", "*", "=", "<"]),
        lambda: pick(["-", "/"]) + pick([" ", "\n", "\t", "\u00a0"]),
        # Ends with nothing, a doubled quote, an escaped quote or an escaped backslash.
        lambda: "'" + literal_body() + pick(["", "''", "\\'", "\\\\"]) + "'",
        lambda: f"`{literal_body()}`",
        lambda: f'"{literal_body()}"',
        # The leading space puts the heredoc at a token start, not inside a name.
        lambda: f" $h${literal_body().replace('$', '')}$h$",
    ]
    gaps = ["", "", " ", "  ", "\n", "\t ", "\r\n", "\u00a0"]

    def piece() -> str:
        gap = pick(gaps)
        return gap + pieces[int(random() * len(pieces))]()

    return ["".join(piece() for _ in range(1 + int(random() * 12))) for _ in range(count)]


def _significant_text(sql: str) -> str:
    # Every token except whitespace and closed comments, with whitespace inside
    # literals collapsed: what must survive normalization.
    return js_trim("".join(
        JS_WHITESPACE_RUN.sub(" ", token.text)
        for token in tokenize_sql(sql)
        if not (is_trivia(token) and token.terminated) and not is_js_space(token.text)
    ))


def _has_closed_comment(sql: str) -> bool:
    return any(
        token.kind in ("line_comment", "block_comment") and token.terminated
        for token in tokenize_sql(sql)
    )
