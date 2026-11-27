"""Statement fingerprints. Port of ``packages/core/src/sql-fingerprint.ts``."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

from chkit.core.sql_lexer import SQLToken, is_trivia, tokenize_sql


def statement_fingerprint(statement: str) -> str:
    """The SQL of a statement, comments and whitespace aside.

    What ClickHouse parses is the same for two statements with the same
    fingerprint. Any other change (a name, a literal, a keyword's case, a
    token added or removed) changes it. Trailing ``;`` do not count. The
    inline data of an ``INSERT … FORMAT <name>`` statement is not SQL:
    everything after the format name counts byte for byte.

    The journal records it per statement, so a resumed or retried migration
    can tell that a statement it skips as completed is the one that ran
    (#599). The ``v1:`` prefix names this encoding; TS computes the same value.
    """
    tokens = [token for token in tokenize_sql(statement) if not is_trivia(token)]
    data_start = _inline_data_start(tokens)
    sql = [
        token.text for token in tokens if data_start is None or token.end <= data_start
    ]
    if data_start is None:
        while sql and sql[-1] == ";":
            sql.pop()
    digest = hashlib.sha256()
    # Each token is length-prefixed, so token boundaries are part of the hash;
    # the inline data starts with ``#``, which no length prefix does.
    for text in sql:
        encoded = text.encode("utf-8")
        digest.update(f"{len(encoded)}:".encode())
        digest.update(encoded)
    if data_start is not None:
        data = statement[data_start:].encode("utf-8")
        digest.update(f"#{len(data)}:".encode())
        digest.update(data)
    return f"v1:{digest.hexdigest()}"


_ROWS_START = frozenset({"SELECT", "WITH", "VALUES"})


def _inline_data_start(tokens: Sequence[SQLToken]) -> int | None:
    """Where the inline data of ``INSERT … FORMAT <name>`` starts.

    Right after the format name. The clause is a ``FORMAT`` outside
    parentheses, followed by a name, that is neither the table name nor after
    the ``SELECT``, ``WITH`` or ``VALUES`` that starts the rows another way.
    None for any other statement. A misreading only makes the fingerprint
    stricter.
    """
    if not tokens or tokens[0].text.upper() != "INSERT":
        return None
    depth = 0
    for index, token in enumerate(tokens):
        if token.text == "(":
            depth += 1
        elif token.text == ")":
            depth -= 1
        if depth != 0 or token.kind != "identifier":
            continue
        word = token.text.upper()
        if word in _ROWS_START:
            return None
        previous = tokens[index - 1].text.upper() if index > 0 else None
        name = tokens[index + 1] if index + 1 < len(tokens) else None
        if (
            word == "FORMAT"
            and previous not in ("INTO", "TABLE")
            and name is not None
            and name.kind == "identifier"
        ):
            return name.end
    return None
