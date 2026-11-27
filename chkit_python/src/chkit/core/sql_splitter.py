"""Split SQL text on statement boundaries, respecting strings/comments.

1:1 port of ``packages/core/src/sql-splitter.ts``: both ports return the same
statements, ``--`` comments stripped and each statement ending in ``;``
(#486). ``test/fixtures/sql-splitter.json`` holds the cases both test suites
check.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field

from chkit.core.sql_lexer import (
    JS_WHITESPACE,
    SQLToken,
    is_trivia,
    iter_sql_tokens,
    js_trim,
    tokenize_sql,
)

# The characters that can start a string, quoted name, block comment or heredoc.
_OPENERS = frozenset("/`'\"$")
# ... and, when the split reads them, a ``//``, ``# `` or ``#!`` comment.
_OPENERS_WITH_LINE_COMMENTS = _OPENERS | {"#"}
_HEREDOC_OPEN = re.compile(r"\$[A-Za-z0-9_]*\$")


def split_sql_statements(text: str) -> list[str]:
    """Split a SQL blob into statements, each ending in ``;``.

    A ``;`` inside a string, a quoted identifier, a block comment, a
    ``$tag$`` heredoc or a ``//``, ``# `` or ``#!`` comment does not end a
    statement. ``--`` comments are not special here:
    `extract_executable_statements` strips them first.
    """
    return [piece.text for piece in _split(text, line_comments=True)]


def extract_executable_statements(text: str) -> list[str]:
    """The statements chkit runs: ``--`` comments stripped, ``;`` kept, as in TS.

    ``--`` inside a string, a quoted identifier, a block comment, a heredoc or
    a ``//``, ``# `` or ``#!`` comment is text and stays. A statement made only
    of comments is not executable: ClickHouse rejects it as "Empty query" (for
    example a block comment after the last statement), so it is dropped.
    """
    return [piece.text for piece in _extract(text, line_comments=True).statements]


@dataclass(frozen=True, slots=True)
class ExecutableStatementWithComments:
    """An executable statement with the ``--`` comments that come before it (#831)."""

    # The statement as `extract_executable_statements` returns it.
    sql: str
    # The ``--`` comments on lines of their own after the previous executable
    # statement and before this one ends, trimmed, in file order. Each block
    # holds the comments that only whitespace separates; a comment after SQL
    # on its line is left out.
    comment_blocks: list[list[str]] = field(default_factory=list)
    # The blocks of ``comment_blocks`` that only whitespace separates from the
    # statement's first character (#888): a marker among them comes right
    # before the statement, with no SQL or other comment in between.
    leading_blocks: list[list[str]] = field(default_factory=list)


def extract_executable_statements_with_comments(text: str) -> list[ExecutableStatementWithComments]:
    """`extract_executable_statements`, with the ``--`` comments of each statement.

    A statement's comments are those between the end of the executable
    statement before it and its own end. A comment after the last statement
    belongs to none. Like the split, it reads a ``--`` inside a string, a
    quoted name, a block comment, a heredoc or a ``//``, ``# `` or ``#!``
    comment as text.
    """
    extracted = _extract(text, line_comments=True)
    statements = extracted.statements
    result = [ExecutableStatementWithComments(sql=piece.text) for piece in statements]
    index = 0
    # The offset of the last comment kept for the statement at ``index``.
    previous_offset: int | None = None
    for comment in extracted.comments:
        while index < len(statements) and statements[index].end <= comment.offset:
            index += 1
            previous_offset = None
        if index >= len(result):
            break
        if not comment.own_line:
            continue
        target = result[index]
        blocks = target.comment_blocks
        if (
            blocks
            and previous_offset is not None
            and js_trim(extracted.stripped[previous_offset : comment.offset]) == ""
        ):
            blocks[-1].append(comment.text)
        else:
            blocks.append([comment.text])
            # The comments of one block are only whitespace apart, so its first one tells.
            start = statements[index].start
            before = extracted.stripped[comment.offset : start]
            if comment.offset <= start and js_trim(before) == "":
                target.leading_blocks.append(blocks[-1])
        previous_offset = comment.offset
    return result


def extract_legacy_executable_statements(text: str) -> list[str]:
    """The statements chkit ran before #562.

    The splitter then did not know ``//``, ``# `` and ``#!`` comments: it cut
    at a ``;`` inside one and read a quote, ``/*`` or ``$tag$`` inside one as
    live. Only for telling whether a migration that an older chkit applied in
    part resumes at the statements it recorded.
    """
    return [piece.text for piece in _extract(text, line_comments=False).statements]


@dataclass(frozen=True, slots=True)
class _Piece:
    text: str
    # The offset of its first non-whitespace character.
    start: int
    # The offset of the ``;`` that ends it, or the end of its last character.
    end: int


@dataclass(frozen=True, slots=True)
class _LineComment:
    # Its offset in the text with ``--`` comments stripped.
    offset: int
    text: str
    # Only whitespace comes before it on its line.
    own_line: bool


@dataclass(frozen=True, slots=True)
class _Extracted:
    statements: list[_Piece]
    comments: list[_LineComment]
    stripped: str


def _split(text: str, *, line_comments: bool) -> list[_Piece]:
    statements: list[_Piece] = []
    current: list[str] = []
    current_start = 0
    lexed_end = _lexed_end_at(text)
    openers = _OPENERS_WITH_LINE_COMMENTS if line_comments else _OPENERS
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        end = _region_end(text, i, lexed_end, line_comments) if ch in openers else None
        if end is not None:
            current.append(text[i:end])
            i = end
            continue
        if ch == ";":
            piece = "".join(current)
            trimmed = js_trim(piece)
            if trimmed:
                statements.append(
                    _Piece(text=f"{trimmed};", start=_start_of(piece, current_start), end=i)
                )
            current = []
            current_start = i + 1
            i += 1
            continue
        current.append(ch)
        i += 1

    rest = "".join(current)
    tail = js_trim(rest)
    if tail:
        trailing = len(rest) - len(rest.rstrip(JS_WHITESPACE))
        statements.append(
            _Piece(text=f"{tail};", start=_start_of(rest, current_start), end=n - trailing)
        )
    return statements


def _start_of(current: str, current_start: int) -> int:
    # ``current`` is the text from ``current_start`` on, so its first
    # non-whitespace character is this many characters further.
    return current_start + len(current) - len(current.lstrip(JS_WHITESPACE))


def _extract(text: str, *, line_comments: bool) -> _Extracted:
    stripped: list[str] = []
    comments: list[_LineComment] = []
    stripped_len = 0
    lexed_end = _lexed_end_at(text)
    openers = _OPENERS_WITH_LINE_COMMENTS if line_comments else _OPENERS
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if text.startswith("--", i):
            # The comment runs to the end of the line; the newline stays.
            newline = text.find("\n", i)
            line_start = text.rfind("\n", 0, i) + 1
            comments.append(
                _LineComment(
                    offset=stripped_len,
                    text=js_trim(text[i : n if newline == -1 else newline]),
                    own_line=js_trim(text[line_start:i]) == "",
                )
            )
            if newline == -1:
                break
            i = newline
            continue
        end = _region_end(text, i, lexed_end, line_comments) if ch in openers else None
        if end is not None:
            stripped.append(text[i:end])
            stripped_len += end - i
            i = end
            continue
        stripped.append(ch)
        stripped_len += 1
        i += 1

    stripped_text = "".join(stripped)
    statements = _split(stripped_text, line_comments=line_comments)
    executable = [s for s in statements if _has_executable_content(s.text)]
    if len(executable) == len(statements):
        return _Extracted(statements, comments, stripped_text)
    # Before #562 the splitter cut a ``#`` or ``//`` comment that holds a ``;``
    # in two; keeping the comment-only piece made ClickHouse reject the file
    # instead of running the commented-out text after the ``;``.
    if not line_comments and any(
        _is_line_comment_with_semicolon(token) for token in tokenize_sql(stripped_text)
    ):
        return _Extracted(statements, comments, stripped_text)
    return _Extracted(executable, comments, stripped_text)


def _region_end(
    text: str, i: int, lexed_end: Callable[[int], int | None], line_comments: bool
) -> int | None:
    """The end of the string, quoted identifier, block comment, heredoc or,
    with ``line_comments``, ``//``, ``# `` or ``#!`` comment that starts at ``i``."""
    end = _quoted_end(text, i, lexed_end)
    if end is not None or not line_comments:
        return end
    return _line_comment_end(text, i)


def _line_comment_end(text: str, i: int) -> int | None:
    """ClickHouse reads ``//``, ``# `` and ``#!`` as a comment up to the next
    ``\\n``, which stays; ``#`` before anything else is not a comment
    (ClickHouse rejects it)."""
    if not text.startswith(("//", "# ", "#!"), i):
        return None
    newline = text.find("\n", i)
    return len(text) if newline == -1 else newline


def _lexed_end_at(text: str) -> Callable[[int], int | None]:
    """Where the ClickHouse lexer reads a heredoc, a block comment (they nest)
    or a backtick-quoted name (with backslash escapes), the offset of its first
    character maps to its end.

    The scanner takes these ends only where it is at such a token itself. The
    legacy split does not know ``//`` and ``#`` comments, so inside one it
    keeps its own reading and statements end where they did before #562. The
    input is
    lexed once, only as far as an offset the scanner asks about, and only when
    a token there could end elsewhere than the scanner reads it.
    """
    tokens = iter_sql_tokens(text)
    ends: dict[int, int] = {}
    lexed_to = 0

    def end_at(i: int) -> int | None:
        nonlocal lexed_to
        while lexed_to <= i:
            token = next(tokens, None)
            if token is None:
                break
            first = token.text[:1]
            if (
                token.kind == "block_comment"
                or (token.kind == "string" and first == "$")
                or (token.kind == "quoted_identifier" and first == "`")
            ):
                ends[token.start] = token.end
            lexed_to = token.end
        return ends.get(i)

    return end_at


def _quoted_end(text: str, i: int, lexed_end: Callable[[int], int | None]) -> int | None:
    """The end of the string, quoted identifier, block comment or heredoc that
    starts at ``i``, or None when none starts there.

    An unclosed quote or block comment runs to the end of the input.
    """
    ch = text[i]
    if text.startswith("/*", i):
        return _block_comment_end(text, i, lexed_end)
    if ch == "`":
        return _backtick_end(text, i, lexed_end)
    if ch in ("'", '"'):
        return _quote_end(text, i, ch)
    # Only a heredoc ClickHouse reads: not an unclosed `$tag$`, nor a `$` inside a name.
    if ch == "$" and _HEREDOC_OPEN.match(text, i):
        return lexed_end(i)
    return None


def _block_comment_end(text: str, i: int, lexed_end: Callable[[int], int | None]) -> int:
    close = text.find("*/", i + 2)
    if close == -1:
        return len(text)
    # The lexer nests comments: it ends elsewhere only when a `/*` opens first.
    if "/*" not in text[i + 2 : close + 1]:
        return close + 2
    end = lexed_end(i)
    return close + 2 if end is None else end


def _backtick_end(text: str, i: int, lexed_end: Callable[[int], int | None]) -> int:
    close = text.find("`", i + 1)
    if close == -1:
        return len(text)
    # The lexer reads backslash escapes and doubled backticks, so it can end later.
    if "\\" not in text[i + 1 : close] and text[close + 1 : close + 2] != "`":
        return close + 1
    end = lexed_end(i)
    return close + 1 if end is None else end


def _quote_end(text: str, i: int, quote: str) -> int:
    """A backslash escapes the next character. A doubled quote ends one quoted
    part and starts the next, which ends where the escaped quote would."""
    j = i + 1
    n = len(text)
    while j < n:
        ch = text[j]
        if ch == "\\" and j + 1 < n:
            j += 2
            continue
        if ch == quote:
            return j + 1
        j += 1
    return n


def _has_executable_content(statement: str) -> bool:
    """False when every token is whitespace or a terminated comment.

    Covers the comment forms left after ``--`` comments are stripped: ``//``,
    ``# ``, ``#!`` and nested ``/* */``. An unterminated comment counts as
    content, so ClickHouse reports it.
    """
    # Only a statement that starts like a comment can be made only of comments.
    if not statement.startswith(("-", "/", "#")):
        return True
    # The splitter appended the `;`; a trailing line comment would swallow it.
    body = statement[:-1] if statement.endswith(";") else statement
    return any(not is_trivia(token) or not token.terminated for token in tokenize_sql(body))


def _is_line_comment_with_semicolon(token: SQLToken) -> bool:
    return token.kind == "line_comment" and ";" in token.text
