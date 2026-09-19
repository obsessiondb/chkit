"""Split SQL text on statement boundaries, respecting strings/comments."""

from __future__ import annotations

from dataclasses import dataclass, field


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


def _handle_in_quote(state: _SplitterState, ch: str, prev: str) -> None:
    state.current.append(ch)
    if ch == state.quote and prev != "\\":
        state.quote = None


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
        prev = text[i - 1] if i > 0 else ""

        if state.in_line_comment:
            _handle_in_line_comment(state, ch)
            i += 1
            continue
        if state.in_block_comment:
            i += _handle_in_block_comment(state, ch, nxt)
            continue
        if state.quote is not None:
            _handle_in_quote(state, ch, prev)
            i += 1
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
    """Return statements stripped of trailing semicolons (preferred by clickhouse-connect)."""
    stripped = [s.rstrip(";").strip() for s in split_sql_statements(text)]
    return [s for s in stripped if s]
