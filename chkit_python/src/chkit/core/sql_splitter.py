"""Split SQL text on statement boundaries, respecting strings/comments.

1:1 port of ``packages/core/src/sql-splitter.ts``: both ports return the same
statements, ``--`` comments stripped and each statement ending in ``;``
(#486). ``test/fixtures/sql-splitter.json`` holds the cases both test suites
check.
"""

from __future__ import annotations

from chkit.core.sql_lexer import SQLToken, is_trivia, js_trim, tokenize_sql


def split_sql_statements(text: str) -> list[str]:
    """Split a SQL blob into statements, each ending in ``;``.

    A ``;`` inside a string, a quoted identifier, a block comment or a
    ``$tag$`` heredoc does not end a statement. ``--`` comments are not
    special here: `extract_executable_statements` strips them first.
    """
    statements: list[str] = []
    current: list[str] = []
    lexed = _lexed_ends(text)
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        end = _quoted_end(text, i, lexed)
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
    lexed = _lexed_ends(text)
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
        end = _quoted_end(text, i, lexed)
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


def _lexed_ends(text: str) -> dict[int, int]:
    """Where the ClickHouse lexer reads a heredoc, a block comment (they nest)
    or a backtick-quoted name (with backslash escapes), the offset of its first
    character maps to its end.

    The scanner takes these ends only where it is at such a token itself;
    inside a ``//`` or ``#`` comment, which it does not know (#197), it keeps
    its own reading, so statements end where they always did.
    """
    ends: dict[int, int] = {}
    for token in tokenize_sql(text):
        first = token.text[:1]
        if (
            token.kind == "block_comment"
            or (token.kind == "string" and first == "$")
            or (token.kind == "quoted_identifier" and first == "`")
        ):
            ends[token.start] = token.end
    return ends


def _quoted_end(text: str, i: int, lexed: dict[int, int]) -> int | None:
    """The end of the string, quoted identifier, block comment or heredoc that
    starts at ``i``, or None when none starts there.

    An unclosed quote or block comment runs to the end of the input.
    """
    ch = text[i]
    if text.startswith("/*", i):
        return lexed.get(i, _close_end(text, i + 2, "*/"))
    if ch == "`":
        return lexed.get(i, _close_end(text, i + 1, "`"))
    if ch in ("'", '"'):
        return _quote_end(text, i, ch)
    # Only a heredoc ClickHouse reads: an unclosed `$tag$`, or a `$` inside a name.
    if ch == "$":
        return lexed.get(i)
    return None


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
