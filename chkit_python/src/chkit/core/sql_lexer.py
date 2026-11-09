"""Lossless ClickHouse SQL lexer.

1:1 port of ``packages/core/src/sql-lexer.ts``. Concatenating every token's
``text`` reproduces the input exactly. It follows ClickHouse's own lexer
closely enough to tell code from strings, quoted identifiers and comments, and
names from numbers; it is not a parser.
"""

from __future__ import annotations

import re
from bisect import bisect_left
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Final, Literal, TypeAlias

SQLTokenKind: TypeAlias = Literal[
    "whitespace",
    "line_comment",
    "block_comment",
    "string",
    "quoted_identifier",
    "identifier",
    "number",
    "punctuation",
]


@dataclass(frozen=True, slots=True)
class SQLToken:
    kind: SQLTokenKind
    # Exact source text of the token.
    text: str
    # Offset of the first character in the input.
    start: int
    # Offset just past the last character.
    end: int
    # ``False`` only for a string, quoted identifier or block comment that runs
    # to the end of the input without its closing delimiter.
    terminated: bool


# The whitespace JavaScript's ``\s`` and ``String.prototype.trim()`` recognize.
# The TS port collapses and trims with those, so the Python port matches them
# exactly instead of using ``str.isspace`` (which differs on \x1c-\x1f, \x85
# and \ufeff).
JS_WHITESPACE: Final[str] = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
JS_WHITESPACE_RUN: Final[re.Pattern[str]] = re.compile(f"[{JS_WHITESPACE}]+")

_WHITESPACE: Final[frozenset[str]] = frozenset(" \t\n\r\f\v")
_ASCII_LETTERS: Final[str] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_DIGITS: Final[frozenset[str]] = frozenset("0123456789")
_HEX_DIGITS: Final[frozenset[str]] = frozenset("0123456789ABCDEFabcdef")
_IDENTIFIER_START: Final[frozenset[str]] = frozenset(_ASCII_LETTERS + "_")
_WORD_CHAR: Final[frozenset[str]] = frozenset(_ASCII_LETTERS + "0123456789_")
_IDENTIFIER_PART: Final[frozenset[str]] = _WORD_CHAR | {"$"}
_HEREDOC_TAG: Final[frozenset[str]] = _WORD_CHAR
_WORD: Final[re.Pattern[str]] = re.compile(r"[A-Za-z0-9_]+")
_EXPONENT: Final[re.Pattern[str]] = re.compile(r"[eE][+-]?[0-9]")
_HEX_EXPONENT: Final[re.Pattern[str]] = re.compile(r"[pP][+-]?[0-9]")
_HEX_PREFIX: Final[re.Pattern[str]] = re.compile(r"0[xX][0-9A-Fa-f]")
_BIN_PREFIX: Final[re.Pattern[str]] = re.compile(r"0[bB][01]")
_HEX_BYTE: Final[re.Pattern[str]] = re.compile(r"[0-9A-Fa-f]{2}")
_LAST_CONTROL_ASCII: Final[int] = 0x1F
# ClickHouse's parseEscapeSequence: the escapes that stand for a control byte.
_CONTROL_ESCAPES: Final[dict[str, str]] = {
    "0": "\0",
    "a": "\x07",
    "b": "\b",
    "e": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
}
# Escaped characters that lose their backslash; any other escape keeps it, so
# a LIKE pattern's ``\%`` stays ``\%`` (parseComplexEscapeSequence).
_PLAIN_ESCAPES: Final[frozenset[str]] = frozenset("\\'\"`/=")


def tokenize_sql(sql: str) -> list[SQLToken]:
    tokens: list[SQLToken] = []
    heredoc_end = _heredoc_reader(sql)
    previous: SQLToken | None = None
    i = 0
    while i < len(sql):
        kind, end, terminated = _read_token(sql, i, previous, heredoc_end)
        token = SQLToken(kind=kind, text=sql[i:end], start=i, end=end, terminated=terminated)
        tokens.append(token)
        if not is_trivia(token):
            previous = token
        i = end
    return tokens


def iter_sql_tokens(sql: str) -> Iterator[SQLToken]:
    """The tokens of `tokenize_sql`, one at a time, for a caller that keeps few of them."""
    heredoc_end = _heredoc_reader(sql)
    previous: SQLToken | None = None
    i = 0
    while i < len(sql):
        kind, end, terminated = _read_token(sql, i, previous, heredoc_end)
        token = SQLToken(kind=kind, text=sql[i:end], start=i, end=end, terminated=terminated)
        yield token
        if not is_trivia(token):
            previous = token
        i = end


def is_trivia(token: SQLToken) -> bool:
    """Whitespace and comments: tokens that never change what a statement means."""
    return token.kind in ("whitespace", "line_comment", "block_comment")


def identifier_name(token: SQLToken) -> str | None:
    """The name an identifier token denotes: bare text, or the unquoted value."""
    if token.kind == "identifier":
        return token.text
    if token.kind != "quoted_identifier" or not token.terminated:
        return None
    return unescape_quoted(token.text[1:-1], token.text[0])


def string_literal_value(token: SQLToken) -> str | None:
    """The value of a terminated string literal (``'…'`` or a ``$tag$…$tag$`` heredoc)."""
    if token.kind != "string" or not token.terminated:
        return None
    if token.text.startswith("$"):
        tag_length = token.text.index("$", 1) + 1
        return token.text[tag_length : len(token.text) - tag_length]
    return unescape_quoted(token.text[1:-1], "'")


def unescape_quoted(body: str, quote: str = "`") -> str:
    r"""The value ClickHouse reads from the body of a quoted name or string literal.

    As ClickHouse's readQuotedString: a doubled ``quote`` is one quote,
    ``\xHH`` is a byte, ``\N`` is nothing, ``\n`` and the other control escapes
    are their byte, ``\\``, ``\'``, ``\"``, ``\```, ``\/`` and ``\=`` drop the
    backslash, and any other escape keeps it (``\q`` is ``\q``). The bytes read
    as UTF-8. An invalid ``\x`` (``\xZZ``) stays as written, where ClickHouse
    reads an arbitrary byte.
    """
    out: list[str] = []
    pending = bytearray()
    i = 0
    while i < len(body):
        char = body[i]
        nxt = _at(body, i + 1)
        hex_byte = body[i + 2 : i + 4]
        if char == "\\" and nxt == "x" and _HEX_BYTE.fullmatch(hex_byte):
            pending.append(int(hex_byte, 16))
            i += 4
            continue
        if pending:
            out.append(pending.decode("utf-8", "replace"))
            pending.clear()
        if char == "\\" and nxt:
            i += 2
            if nxt == "N":
                continue
            decoded = _CONTROL_ESCAPES.get(nxt, nxt)
            # A raw control character after a backslash drops it too (isControlASCII).
            if decoded not in _PLAIN_ESCAPES and ord(decoded) > _LAST_CONTROL_ASCII:
                out.append("\\")
            out.append(decoded)
            continue
        if char == quote and nxt == quote:
            out.append(quote)
            i += 2
            continue
        out.append(char)
        i += 1
    if pending:
        out.append(pending.decode("utf-8", "replace"))
    return "".join(out)


def is_js_space(char: str) -> bool:
    """Whether ``char`` is one character JavaScript's ``/^\\s$/`` matches."""
    return len(char) == 1 and char in JS_WHITESPACE


def js_trim(value: str) -> str:
    """``String.prototype.trim()``: strips JavaScript whitespace at both ends."""
    return value.strip(JS_WHITESPACE)


_TokenEnd: TypeAlias = tuple[SQLTokenKind, int, bool]
# The end of the heredoc that opens at an offset, or None when none does.
_HeredocReader: TypeAlias = Callable[[int], int | None]


def _read_token(  # noqa: PLR0911
    sql: str, i: int, previous: SQLToken | None, read_heredoc: _HeredocReader
) -> _TokenEnd:
    # ``previous`` is the last token that is not trivia; ClickHouse uses it to
    # tell a qualifier dot from the start of a number.
    char = _at(sql, i)
    nxt = _at(sql, i + 1)
    if char in _WHITESPACE:
        return ("whitespace", _skip_while(sql, i, _WHITESPACE), True)
    # `--x`, `//x`, `# x` and `#!x` are line comments; `#x` is not (ClickHouse rejects it).
    if (
        (char == "-" and nxt == "-")
        or (char == "/" and nxt == "/")
        or (char == "#" and nxt in (" ", "!"))
    ):
        return ("line_comment", _line_end(sql, i), True)
    if char == "/" and nxt == "*":
        return _read_block_comment(sql, i)
    if char == "'":
        end, terminated = _read_quoted(sql, i, "'")
        return ("string", end, terminated)
    if char in ("`", '"'):
        end, terminated = _read_quoted(sql, i, char)
        return ("quoted_identifier", end, terminated)
    if char == "$":
        heredoc_end = read_heredoc(i)
        if heredoc_end is not None:
            return ("string", heredoc_end, True)
        if nxt in _WORD_CHAR:
            return ("identifier", _skip_while(sql, i, _IDENTIFIER_PART), True)
    if char in _DIGITS:
        return _read_number_or_word(sql, i, previous is not None and previous.text == ".")
    if char == "." and nxt in _DIGITS and not _ends_operand(previous):
        return ("number", _fraction_end(sql, i), True)
    if char in _IDENTIFIER_START:
        return ("identifier", _skip_while(sql, i, _IDENTIFIER_PART), True)
    return ("punctuation", i + 1, True)


def _read_number_or_word(sql: str, i: int, after_dot: bool) -> _TokenEnd:
    # ClickHouse reads a digit-led run as a numeric literal and, when word
    # characters continue it, as a bare word: `1m_rollup` and `2024db` are
    # names, while `1_000`, `1.5e+3` and `0x1F` are numbers. Right after a `.`
    # only integer digits form the literal, so `t.1.2` is tuple access and
    # `db.1e5` is a name. Word characters exclude `$` here: `1a$b` is `1a`
    # followed by `$b`.
    literal_end = _digits_end(sql, i, _DIGITS) if after_dot else _numeric_literal_end(sql, i)
    end = _skip_while(sql, literal_end, _WORD_CHAR)
    is_name = end > literal_end and _WORD.fullmatch(sql[i:end]) is not None
    return ("identifier" if is_name else "number", end, True)


def _numeric_literal_end(sql: str, i: int) -> int:
    # An optional 0x/0b prefix, digits, an optional fraction and an optional
    # exponent. A `.` joins the literal only before a digit, so `1.x` keeps its dot.
    prefix = sql[i : i + 3]
    is_hex = _HEX_PREFIX.match(prefix) is not None
    digit = _HEX_DIGITS if is_hex else _DIGITS
    start = i + 2 if is_hex or _BIN_PREFIX.match(prefix) is not None else i
    j = _digits_end(sql, start, digit)
    if _at(sql, j) == "." and _at(sql, j + 1) in _DIGITS:
        j = _digits_end(sql, j + 1, digit)
    exponent = (_HEX_EXPONENT if is_hex else _EXPONENT).match(sql[j : j + 3])
    return _digits_end(sql, j + len(exponent.group(0)) - 1, _DIGITS) if exponent else j


def _digits_end(sql: str, i: int, digit: frozenset[str]) -> int:
    # One block of digits; `_` may separate two digits (`1_000`).
    j = i
    while j < len(sql):
        char = sql[j]
        separator = char == "_" and j > i and _at(sql, j + 1) in digit
        if char not in digit and not separator:
            break
        j += 1
    return j


def _fraction_end(sql: str, i: int) -> int:
    # `.5` or `.5e3` where a value starts.
    j = _skip_while(sql, i + 1, _DIGITS)
    exponent = _EXPONENT.match(sql[j : j + 3])
    return _skip_while(sql, j + len(exponent.group(0)) - 1, _DIGITS) if exponent else j


def _ends_operand(token: SQLToken | None) -> bool:
    # After a name, a number, `)` or `]`, a `.` is a qualifier or tuple access.
    if token is None:
        return False
    return token.kind in ("identifier", "quoted_identifier", "number") or token.text in (")", "]")


def _read_block_comment(sql: str, i: int) -> _TokenEnd:
    # ClickHouse block comments nest: `/* a /* b */ c */` is one comment.
    depth = 0
    j = i
    while j < len(sql):
        if sql.startswith("/*", j):
            depth += 1
            j += 2
        elif sql.startswith("*/", j):
            depth -= 1
            j += 2
            if depth == 0:
                return ("block_comment", j, True)
        else:
            j += 1
    return ("block_comment", len(sql), False)


def _read_quoted(sql: str, i: int, quote: str) -> tuple[int, bool]:
    # A doubled delimiter or a backslash escapes the delimiter inside quotes.
    j = i + 1
    while j < len(sql):
        char = sql[j]
        if char == "\\":
            j += 2
            continue
        if char == quote:
            if _at(sql, j + 1) == quote:
                j += 2
                continue
            return (j + 1, True)
        j += 1
    return (len(sql), False)


def _heredoc_reader(sql: str) -> _HeredocReader:
    # `$tag$ … $tag$` (including `$$ … $$`), where the tag is `[A-Za-z0-9_]*`. It
    # is only a literal when the same tag closes it later; otherwise ClickHouse
    # reads the `$` as part of an identifier or as punctuation. The closer is
    # the first later occurrence of the opener's text. Searching the rest of the
    # input once per opener is quadratic on many unclosed openers (#585), so the
    # first opener indexes every `$tag$` in the input and each one is a lookup.
    tag_starts: dict[str, list[int]] | None = None

    def read(i: int) -> int | None:
        nonlocal tag_starts
        tag_end = _skip_while(sql, i + 1, _HEREDOC_TAG)
        if _at(sql, tag_end) != "$":
            return None
        if tag_starts is None:
            tag_starts = _index_heredoc_tags(sql)
        offsets = tag_starts.get(sql[i + 1 : tag_end], [])
        k = bisect_left(offsets, tag_end + 1)
        return None if k == len(offsets) else offsets[k] + tag_end + 1 - i

    return read


def _index_heredoc_tags(sql: str) -> dict[str, list[int]]:
    # Every offset where `$tag$` occurs, in order, by tag. An occurrence is a
    # `$`, the longest run of tag characters after it, then a `$` (a tag
    # character is never `$`), so each `$` starts at most one and the scan is
    # linear.
    starts: dict[str, list[int]] = {}
    i = sql.find("$")
    while i != -1:
        tag_end = _skip_while(sql, i + 1, _HEREDOC_TAG)
        if _at(sql, tag_end) == "$":
            starts.setdefault(sql[i + 1 : tag_end], []).append(i)
        i = sql.find("$", i + 1)
    return starts


def _at(sql: str, i: int) -> str:
    return sql[i] if 0 <= i < len(sql) else ""


def _skip_while(sql: str, i: int, chars: frozenset[str]) -> int:
    j = i
    while j < len(sql) and sql[j] in chars:
        j += 1
    return j


def _line_end(sql: str, i: int) -> int:
    newline = sql.find("\n", i)
    return len(sql) if newline == -1 else newline
