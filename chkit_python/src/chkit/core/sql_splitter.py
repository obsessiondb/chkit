"""Split SQL text on statement boundaries, respecting strings/comments.

1:1 port of ``packages/core/src/sql-splitter.ts``: both ports return the same
statements, ``--`` comments stripped and each statement ending in ``;``
(#486). ``test/fixtures/sql-splitter.json`` holds the cases both test suites
check.
"""

from __future__ import annotations

from collections.abc import Callable

from chkit.core.sql_lexer import (
    SQLToken,
    is_trivia,
    iter_sql_tokens,
    js_trim,
    read_block_comment,
    read_heredoc,
    read_quoted,
    tokenize_sql,
)

# The characters that can start a string, quoted name, block comment or heredoc.
_OPENERS = frozenset("/`'\"$")


def split_sql_statements(text: str) -> list[str]:
    """Split a SQL blob into statements, each ending in ``;``.

    A ``;`` inside a string, a quoted identifier, a block comment or a
    ``$tag$`` heredoc does not end a statement. ``--`` comments are not
    special here: `extract_executable_statements` strips them first.
    """
    statements: list[str] = []
    current: list[str] = []
    lexed_end = _lexed_end_at(text)
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        end = _quoted_end(text, i, lexed_end) if ch in _OPENERS else None
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


def extract_executable_statements(text: str) -> list[str]:
    """The statements chkit runs: ``--`` comments stripped, ``;`` kept, as in TS.

    ``--`` inside a string, a quoted identifier, a block comment or a heredoc
    is text and stays. A statement made only of comments is not executable:
    ClickHouse rejects it as "Empty query" (for example a block comment after
    the last statement), so it is dropped. The splitter does not know ``#``
    and ``//`` line comments; when one of them holds a ``;`` the splitter cut
    that comment line in two, and keeping the comment-only piece makes
    ClickHouse reject the file instead of running the commented-out text after
    the ``;``.
    """
    stripped: list[str] = []
    lexed_end = _lexed_end_at(text)
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
        end = _quoted_end(text, i, lexed_end) if ch in _OPENERS else None
        if end is not None:
            stripped.append(text[i:end])
            i = end
            continue
        stripped.append(ch)
        i += 1

    stripped_text = "".join(stripped)
    statements = split_sql_statements(stripped_text)
    executable = [s for s in statements if _has_executable_content(s)]
    if len(executable) == len(statements):
        return statements
    if any(_is_line_comment_with_semicolon(token) for token in tokenize_sql(stripped_text)):
        return statements
    return executable


def _lexed_end_at(text: str) -> Callable[[int], int | None]:
    """Where the ClickHouse lexer reads a heredoc, a block comment (they nest)
    or a backtick-quoted name (with backslash escapes), the offset of its first
    character maps to its end.

    The scanner takes these ends only where it is at such a token itself;
    inside a ``//`` or ``#`` comment, which it does not know (#197), it keeps
    its own reading, so statements end where they always did. The input is
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
        end = _close_end(text, i + 2, "*/")
        return end if read_block_comment(text, i)[1] == end else _or(lexed_end(i), end)
    if ch == "`":
        end = _close_end(text, i + 1, "`")
        return end if read_quoted(text, i, ch)[0] == end else _or(lexed_end(i), end)
    if ch in ("'", '"'):
        return _quote_end(text, i, ch)
    # Only a heredoc ClickHouse reads: an unclosed `$tag$`, or a `$` inside a name.
    if ch == "$":
        return None if read_heredoc(text, i) is None else lexed_end(i)
    return None


def _or(value: int | None, default: int) -> int:
    return default if value is None else value


def _close_end(text: str, start: int, close: str) -> int:
    at = text.find(close, start)
    return len(text) if at == -1 else at + len(close)


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
