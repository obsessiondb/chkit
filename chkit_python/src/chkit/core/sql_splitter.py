"""Split SQL text on statement boundaries, respecting strings/comments."""

from __future__ import annotations

from dataclasses import dataclass, field

from chkit.core.sql_lexer import is_trivia, tokenize_sql


@dataclass
class _SplitterState:
    statements: list[str] = field(default_factory=list)
    current: list[str] = field(default_factory=list)
    quote: str | None = None
    in_line_comment: bool = False
    in_block_comment: bool = False


def _handle_in_line_comment(state: _SplitterState, ch: str) -> None:
    state.current.append(ch)
    if ch == "\n":
        state.in_line_comment = False


def _handle_in_block_comment(state: _SplitterState, ch: str, nxt: str) -> int:
    state.current.append(ch)
    if ch == "*" and nxt == "/":
        state.current.append(nxt)
        state.in_block_comment = False
        return 2
    return 1


def _handle_in_quote(state: _SplitterState, ch: str, nxt: str) -> int:
    state.current.append(ch)
    if nxt and (ch == "\\" or ch == state.quote == nxt):
        state.current.append(nxt)
        return 2
    if ch == state.quote:
        state.quote = None
    return 1


def _flush_statement(state: _SplitterState) -> None:
    statement = "".join(state.current).strip()
    if statement and statement != ";":
        state.statements.append(statement)
    state.current = []


def split_sql_statements(text: str) -> list[str]:
    """Split a SQL blob into individual statements.

    Handles single/double quotes, backtick identifiers, and ``-- line``
    comments. Multi-line ``/* */`` comments are also preserved as-is.
    """
    state = _SplitterState()
    i = 0
    n = len(text)

    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        if state.in_line_comment:
            _handle_in_line_comment(state, ch)
            i += 1
            continue
        if state.in_block_comment:
            i += _handle_in_block_comment(state, ch, nxt)
            continue
        if state.quote is not None:
            i += _handle_in_quote(state, ch, nxt)
            continue
        if ch == "-" and nxt == "-":
            state.current.append(ch)
            state.in_line_comment = True
            i += 1
            continue
        if ch == "/" and nxt == "*":
            state.current.append(ch)
            state.current.append(nxt)
            state.in_block_comment = True
            i += 2
            continue
        if ch in {"'", '"', "`"}:
            state.quote = ch
            state.current.append(ch)
            i += 1
            continue
        if ch == ";":
            state.current.append(ch)
            _flush_statement(state)
            i += 1
            continue
        state.current.append(ch)
        i += 1

    tail = "".join(state.current).strip()
    if tail:
        state.statements.append(tail if tail.endswith(";") else f"{tail};")
    return state.statements


def extract_executable_statements(text: str) -> list[str]:
    """Return statements stripped of trailing semicolons (preferred by clickhouse-connect).

    A statement made only of comments is not executable: ClickHouse rejects it
    as "Empty query" (for example a block comment after the last statement),
    so it is dropped. The splitter does not know ``#`` and ``//`` line
    comments; when one of them holds a ``;`` the splitter cut that comment
    line in two, and keeping the comment-only piece makes ClickHouse reject
    the file instead of running the commented-out text after the ``;``.
    """
    stripped = [s.rstrip(";").strip() for s in split_sql_statements(text)]
    statements = [s for s in stripped if s]
    executable = [s for s in statements if _has_executable_content(s)]
    if len(executable) == len(statements):
        return statements
    if _has_line_comment_with_semicolon(text):
        return statements
    return executable


def _has_executable_content(statement: str) -> bool:
    """False when every token is whitespace or a terminated comment.

    Covers every ClickHouse comment form: ``--``, ``//``, ``# ``, ``#!`` and
    nested ``/* */``. An unterminated comment counts as content, so
    ClickHouse reports it.
    """
    # Only a statement that starts like a comment can be made only of comments.
    if not statement.startswith(("-", "/", "#")):
        return True
    return any(not is_trivia(token) or not token.terminated for token in tokenize_sql(statement))


def _has_line_comment_with_semicolon(text: str) -> bool:
    # `--` comments never reach the splitter's cut in TS (they are stripped
    # first), so only `//`, `# ` and `#!` comments count here.
    return any(
        token.kind == "line_comment" and not token.text.startswith("--") and ";" in token.text
        for token in tokenize_sql(text)
    )
