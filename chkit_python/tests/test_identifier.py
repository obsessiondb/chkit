"""Tests for ``chkit.core.identifier`` (TS ``unquoteIdentifiers``)."""

from __future__ import annotations

from chkit.core.identifier import unescape_quoted, unquote_identifiers


def test_unquotes_backtick_identifiers_and_resolves_escapes() -> None:
    assert unquote_identifiers("(`a`, `w)x`)") == "(a, w)x)"
    assert unquote_identifiers("`we\\`ird`") == "we`ird"
    assert unquote_identifiers("`we``ird`") == "we`ird"
    assert unquote_identifiers("`back\\\\slash`") == "back\\slash"


def test_leaves_string_literals_untouched() -> None:
    assert unquote_identifiers("concat(`a`, '`b`')") == "concat(a, '`b`')"
    assert unquote_identifiers("'it''s `x`', `y`") == "'it''s `x`', y"


def test_unescape_quoted_honours_the_given_quote() -> None:
    assert unescape_quoted("it''s", "'") == "it's"
    assert unescape_quoted("a\\'b", "'") == "a'b"
