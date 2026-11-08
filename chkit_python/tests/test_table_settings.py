"""``setting_value_fingerprint`` gives the same text as TS (#466).

The table is the one in ``packages/core/src/table-settings.test.ts``.
"""

from __future__ import annotations

import pytest

from chkit.core.table_settings import setting_value_fingerprint

FINGERPRINTS: list[tuple[str | int | float | bool, str]] = [
    ("8192", "8192"),
    (8192, "8192"),
    ("8192.", "8192"),
    ("1e6", "1000000"),
    ("1000000.", "1000000"),
    ("1E+6", "1000000"),
    ("2.0", "2"),
    ("2.", "2"),
    ("2", "2"),
    ("-2.50", "-2.5"),
    ("+7", "7"),
    (".5", "0.5"),
    ("007", "7"),
    ("-0", "0"),
    ("0.0", "0"),
    ("1e-7", "0.0000001"),
    ("0.00001", "0.00001"),
    (0.00001, "0.00001"),
    ("1e21", "1000000000000000000000"),
    (1e21, "1000000000000000000000"),
    ("123.456", "123.456"),
    ("9007199254740993", "9007199254740993"),
    ("18446744073709551615", "18446744073709551615"),
    ("18446744073709551615.", "18446744073709551615"),
    ("1e500", "1e500"),
    ("1.5e-500", "15e-501"),
    (True, "1"),
    (False, "0"),
    ("true", "1"),
    ("FALSE", "0"),
    ("s3", "s3"),
    ("e5", "e5"),
    ("", ""),
]


@pytest.mark.parametrize(("value", "expected"), FINGERPRINTS)
def test_one_exact_decimal_form_for_every_spelling_and_1_0_for_booleans(
    value: str | int | float | bool, expected: str
) -> None:
    assert setting_value_fingerprint(value) == expected


def test_tells_apart_integers_a_float_cannot() -> None:
    assert setting_value_fingerprint("9007199254740992") != setting_value_fingerprint(
        "9007199254740993"
    )
    assert setting_value_fingerprint("18446744073709551615") != setting_value_fingerprint(
        "18446744073709551614"
    )
