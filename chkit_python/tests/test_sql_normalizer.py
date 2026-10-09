"""Tests for `chkit.core.sql_normalizer` expression helpers."""

from __future__ import annotations

import json

from chkit.core.sql_normalizer import is_synthetic_ephemeral_default, sql_expression_fingerprint


def test_unlexable_expressions_fall_back_to_whitespace_normalized_text() -> None:
    for value in ["$$it's", "concat(a", "a; b", "/* open", "'\\xZZ'"]:
        assert sql_expression_fingerprint(value) == json.dumps(value)
    assert sql_expression_fingerprint("concat(a;\n  x)") == sql_expression_fingerprint(
        " concat(a; x) "
    )
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
