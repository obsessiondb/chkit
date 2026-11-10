"""Split SQL text on statement boundaries, respecting strings/comments.

1:1 port of ``packages/core/src/sql-splitter.ts``: both ports return the same
statements, ``--`` comments stripped and each statement ending in ``;``
(#486). ``test/fixtures/sql-splitter.json`` holds the cases both test suites
check.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from chkit.core.sql_lexer import (
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
    return _split(text, line_comments=True)


def extract_executable_statements(text: str) -> list[str]:
    """The statements chkit runs: ``--`` comments stripped, ``;`` kept, as in TS.

    ``--`` inside a string, a quoted identifier, a block comment, a heredoc or
    a ``//``, ``# `` or ``#!`` comment is text and stays. A statement made only
    of comments is not executable: ClickHouse rejects it as "Empty query" (for
    example a block comment after the last statement), so it is dropped.
    """
    return _extract(text, line_comments=True)


def extract_legacy_executable_statements(text: str) -> list[str]:
    """The statements chkit ran before #562.

    The splitter then did not know ``//``, ``# `` and ``#!`` comments: it cut
    at a ``;`` inside one and read a quote, ``/*`` or ``$tag$`` inside one as
    live. Only for telling whether a migration that an older chkit applied in
    part resumes at the statements it recorded.
    """
    return _extract(text, line_comments=False)


def _split(text: str, *, line_comments: bool) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
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
            trimmed = js_trim("".join(current))
            if trimmed:
                statements.append(f"{trimmed};")
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1

    tail = js_trim("".join(current))
    if tail:
        statements.append(f"{tail};")
    return statements


def _extract(text: str, *, line_comments: bool) -> list[str]:
    stripped: list[str] = []
    lexed_end = _lexed_end_at(text)
    openers = _OPENERS_WITH_LINE_COMMENTS if line_comments else _OPENERS
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if text.startswith("--", i):
            # The comment runs to the end of the line; the newline stays.
            newline = text.find("\n", i)
            if newline == -1:
                break
            i = newline
            continue
        end = _region_end(text, i, lexed_end, line_comments) if ch in openers else None
        if end is not None:
            stripped.append(text[i:end])
            i = end
            continue
        stripped.append(ch)
        i += 1

    stripped_text = "".join(stripped)
    statements = _split(stripped_text, line_comments=line_comments)
    executable = [s for s in statements if _has_executable_content(s)]
    if len(executable) == len(statements):
        return statements
    # Before #562 the splitter cut a ``#`` or ``//`` comment that holds a ``;``
    # in two; keeping the comment-only piece made ClickHouse reject the file
    # instead of running the commented-out text after the ``;``.
    if not line_comments and any(
        _is_line_comment_with_semicolon(token) for token in tokenize_sql(stripped_text)
    ):
        return statements
    return executable


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
