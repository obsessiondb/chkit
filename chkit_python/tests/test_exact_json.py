"""``parse_json_result`` keeps the digits ClickHouse sent (#381).

Same body and expectations as the TS ``exact-json.test.ts``.
"""

from __future__ import annotations

from chkit.clickhouse.client import parse_json_result

# A FORMAT JSON body as ClickHouse 26.3 writes it, with
# output_format_json_quote_64bit_integers and _decimals at their default 0.
BODY = """{
    "meta": [
        {"name": "u64", "type": "UInt64"},
        {"name": "arr", "type": "Array(UInt64)"},
        {"name": "nd", "type": "Nullable(Decimal(18, 3))"},
        {"name": "u32", "type": "UInt32"},
        {"name": "f", "type": "Float64"},
        {"name": "dt64", "type": "DateTime64(3, 'UTC')"}
    ],
    "data": [
        {"u64": 18446744073709551615, "arr": [9007199254740993, 1], "nd": 1.500, "u32": 7,
         "f": 0.5, "dt64": "2026-10-31 00:32:27.123"},
        {"u64": 0, "arr": [], "nd": null, "u32": 0, "f": -1e-7, "dt64": "2026-10-31 00:32:27.123"}
    ],
    "totals": {"u64": 18446744073709551615, "arr": [], "nd": 12345678901234567890.123, "u32": 7,
               "f": 0.5, "dt64": "2026-10-31 00:32:27.123"},
    "extremes": {
        "min": {"u64": 0, "arr": [], "nd": 1.500, "u32": 0, "f": -1e-7, "dt64": "2026-10-31 00:32:27.123"},
        "max": {"u64": 18446744073709551615, "arr": [9007199254740993], "nd": 1.500, "u32": 7,
                "f": 0.5, "dt64": "2026-10-31 00:32:27.123"}
    },
    "rows": 2,
    "statistics": {"elapsed": 0.000613, "rows_read": 1, "bytes_read": 1}
}"""


def test_keeps_the_digits_of_64_bit_and_wider_integers_and_decimals_as_strings() -> None:
    result = parse_json_result(BODY)

    assert result["data"] == [
        {
            "u64": "18446744073709551615",
            "arr": ["9007199254740993", "1"],
            "nd": "1.500",
            "u32": 7,
            "f": 0.5,
            "dt64": "2026-10-31 00:32:27.123",
        },
        {"u64": "0", "arr": [], "nd": None, "u32": 0, "f": -1e-7, "dt64": "2026-10-31 00:32:27.123"},
    ]
    # Plain types, not the parser's str subclasses.
    assert type(result["data"][0]["u64"]) is str
    assert type(result["data"][0]["u32"]) is int
    assert type(result["data"][0]["f"]) is float


def test_keeps_the_digits_in_the_totals_and_extremes_rows_too_by_the_same_column_types() -> None:
    result = parse_json_result(BODY)

    assert result["totals"] == {
        "u64": "18446744073709551615",
        "arr": [],
        "nd": "12345678901234567890.123",
        "u32": 7,
        "f": 0.5,
        "dt64": "2026-10-31 00:32:27.123",
    }
    assert result["extremes"] == {
        "min": {"u64": "0", "arr": [], "nd": "1.500", "u32": 0, "f": -1e-7, "dt64": "2026-10-31 00:32:27.123"},
        "max": {
            "u64": "18446744073709551615",
            "arr": ["9007199254740993"],
            "nd": "1.500",
            "u32": 7,
            "f": 0.5,
            "dt64": "2026-10-31 00:32:27.123",
        },
    }
    assert type(result["totals"]["u32"]) is int
    assert type(result["extremes"]["max"]["f"]) is float


def test_keeps_the_rest_of_the_envelope_as_clickhouse_sent_it() -> None:
    result = parse_json_result(BODY)

    assert list(result) == ["meta", "data", "totals", "extremes", "rows", "statistics"]
    assert result["rows"] == 2
    assert result["statistics"] == {"elapsed": 0.000613, "rows_read": 1, "bytes_read": 1}
    assert type(result["statistics"]["elapsed"]) is float


def test_reads_an_empty_body_from_a_statement_without_a_result_set_as_no_rows() -> None:
    assert parse_json_result("") == {"data": [], "meta": [], "rows": 0}
    assert parse_json_result(b" \n") == {"data": [], "meta": [], "rows": 0}
