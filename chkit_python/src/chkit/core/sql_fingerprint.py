"""Statement fingerprints. Port of ``packages/core/src/sql-fingerprint.ts``."""

from __future__ import annotations

import hashlib

from chkit.core.sql_lexer import is_trivia, tokenize_sql


def statement_fingerprint(statement: str) -> str:
    """The SQL of a statement, comments and whitespace aside.

    What ClickHouse parses is the same for two statements with the same
    fingerprint. Any other change (a name, a literal, a keyword's case, a
    token added or removed) changes it. Trailing ``;`` do not count.

    The journal records it per statement, so a resumed or retried migration
    can tell that a statement it skips as completed is the one that ran
    (#599). The ``v1:`` prefix names this encoding; TS computes the same value.
    """
    tokens = [token.text for token in tokenize_sql(statement) if not is_trivia(token)]
    while tokens and tokens[-1] == ";":
        tokens.pop()
    digest = hashlib.sha256()
    # Each token is length-prefixed, so token boundaries are part of the hash.
    for text in tokens:
        encoded = text.encode("utf-8")
        digest.update(f"{len(encoded)}:".encode())
        digest.update(encoded)
    return f"v1:{digest.hexdigest()}"
