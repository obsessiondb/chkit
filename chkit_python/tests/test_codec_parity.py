"""1:1 port of ``packages/core/src/codec.test.ts``.

Tests are grouped to mirror the TS describe/test structure.
"""

from __future__ import annotations

from typing import Any

import pytest

from chkit.core.codec import (
    CodecSpecInput,
    canonicalize_codec,
    codec_fingerprint,
    codec_raw,
    codecs_equal,
    is_general_codec,
    is_preprocessor_codec,
    parse_codec,
    render_codec,
)

# ───────────── renderCodec ─────────────


def test_render_single_general_codec_without_level() -> None:
    assert render_codec({"kind": "LZ4"}) == "CODEC(LZ4)"


def test_render_zstd_with_explicit_level() -> None:
    assert render_codec({"kind": "ZSTD", "level": 3}) == "CODEC(ZSTD(3))"


def test_render_zstd_without_level_bare_name() -> None:
    assert render_codec({"kind": "ZSTD"}) == "CODEC(ZSTD)"


def test_render_lz4hc_with_level() -> None:
    assert render_codec({"kind": "LZ4HC", "level": 9}) == "CODEC(LZ4HC(9))"


def test_render_chain_delta_zstd() -> None:
    rendered = render_codec(
        [{"kind": "Delta", "size": 4}, {"kind": "ZSTD", "level": 3}]
    )
    assert rendered == "CODEC(Delta(4), ZSTD(3))"


def test_render_fpc_with_both_args() -> None:
    assert (
        render_codec({"kind": "FPC", "level": 10, "floatSize": 4})
        == "CODEC(FPC(10, 4))"
    )


def test_render_gcd_as_preprocessor_before_general_codec() -> None:
    # #408: GCD only transforms, so it precedes the general codec.
    gcd = parse_codec("CODEC(GCD)")
    assert gcd is not None
    assert is_preprocessor_codec(gcd[0])
    assert not is_general_codec(gcd[0])
    assert render_codec([{"kind": "GCD"}, {"kind": "LZ4"}]) == "CODEC(GCD, LZ4)"


def test_render_t64_as_preprocessor_before_general_codec() -> None:
    # #434: T64 compresses alone and also precedes a general codec.
    t64 = parse_codec("CODEC(T64)")
    assert t64 is not None
    assert is_preprocessor_codec(t64[0])
    assert not is_general_codec(t64[0])
    assert render_codec([{"kind": "T64"}, {"kind": "ZSTD", "level": 3}]) == "CODEC(T64, ZSTD(3))"


def test_render_none_t64_gcd_alp_bare() -> None:
    assert render_codec({"kind": "NONE"}) == "CODEC(NONE)"
    assert render_codec({"kind": "T64"}) == "CODEC(T64)"
    assert render_codec({"kind": "GCD"}) == "CODEC(GCD)"
    assert render_codec({"kind": "ALP"}) == "CODEC(ALP)"


def test_render_raw_verbatim() -> None:
    assert render_codec(codec_raw("SomeNewCodec(42)")) == "CODEC(SomeNewCodec(42))"


def test_render_raw_embedded_in_chain() -> None:
    chain: list[Any] = [{"kind": "Delta", "size": 4}, codec_raw("SomeNewCodec(42)")]
    assert render_codec(chain) == "CODEC(Delta(4), SomeNewCodec(42))"


# ───────────── parseCodec ─────────────


def test_parse_empty_returns_none() -> None:
    assert parse_codec("") is None
    assert parse_codec(None) is None


def test_parse_bare_zstd() -> None:
    parsed = parse_codec("CODEC(ZSTD)")
    assert parsed is not None
    assert [c.model_dump(exclude_none=True) for c in parsed] == [{"kind": "ZSTD"}]


def test_parse_zstd_with_level() -> None:
    parsed = parse_codec("CODEC(ZSTD(3))")
    assert parsed is not None
    assert [c.model_dump(exclude_none=True) for c in parsed] == [
        {"kind": "ZSTD", "level": 3}
    ]


def test_parse_lz4hc_with_level() -> None:
    parsed = parse_codec("CODEC(LZ4HC(9))")
    assert parsed is not None
    assert [c.model_dump(exclude_none=True) for c in parsed] == [
        {"kind": "LZ4HC", "level": 9}
    ]


def test_parse_delta_zstd_chain() -> None:
    parsed = parse_codec("CODEC(Delta(4), ZSTD(1))")
    assert parsed is not None
    assert [c.model_dump(exclude_none=True) for c in parsed] == [
        {"kind": "Delta", "size": 4},
        {"kind": "ZSTD", "level": 1},
    ]


def test_parse_fpc_with_both_args() -> None:
    parsed = parse_codec("CODEC(FPC(10, 4))")
    assert parsed is not None
    assert [c.model_dump(exclude_none=True, by_alias=True) for c in parsed] == [
        {"kind": "FPC", "level": 10, "floatSize": 4}
    ]


def test_parse_bare_codecs() -> None:
    for name in ["NONE", "T64", "GCD", "ALP"]:
        parsed = parse_codec(f"CODEC({name})")
        assert parsed is not None
        assert [c.model_dump(exclude_none=True) for c in parsed] == [{"kind": name}]


def test_parse_falls_back_to_raw_for_unknown_tokens() -> None:
    parsed = parse_codec("CODEC(SomeNewCodec(42))")
    assert parsed is not None
    assert [c.model_dump() for c in parsed] == [
        {"kind": "raw", "expression": "SomeNewCodec(42)"}
    ]


def test_parse_raw_fallback_round_trips_through_render() -> None:
    parsed = parse_codec("CODEC(SomeNewCodec(42))")
    assert parsed is not None
    assert render_codec(parsed) == "CODEC(SomeNewCodec(42))"


def test_parse_falls_back_to_raw_when_known_codec_has_unexpected_args() -> None:
    cases = {
        "CODEC(ZSTD(3, 24, 1))": "ZSTD(3, 24, 1)",
        "CODEC(LZ4HC(9, 1))": "LZ4HC(9, 1)",
        "CODEC(Delta(4, 2))": "Delta(4, 2)",
        "CODEC(LZ4(1))": "LZ4(1)",
    }
    for raw, expression in cases.items():
        parsed = parse_codec(raw)
        assert parsed is not None
        assert [c.model_dump() for c in parsed] == [
            {"kind": "raw", "expression": expression}
        ]


def test_parse_reads_a_negative_level_back_from_the_unsigned_form_clickhouse_prints() -> None:
    zstd = parse_codec("CODEC(ZSTD(18446744073709551615))")
    lz4hc = parse_codec("CODEC(LZ4HC(18446744073709551614))")
    assert zstd is not None
    assert lz4hc is not None
    assert [c.model_dump(exclude_none=True) for c in zstd] == [{"kind": "ZSTD", "level": -1}]
    assert [c.model_dump(exclude_none=True) for c in lz4hc] == [{"kind": "LZ4HC", "level": -2}]


# ───────────── canonicalizeCodec ─────────────


def test_canonicalize_fills_in_zstd_default_level() -> None:
    canon = canonicalize_codec({"kind": "ZSTD"})
    assert [c.model_dump(exclude_none=True) for c in canon] == [
        {"kind": "ZSTD", "level": 1}
    ]


def test_canonicalize_fills_in_lz4hc_default_level() -> None:
    canon = canonicalize_codec({"kind": "LZ4HC"})
    assert [c.model_dump(exclude_none=True) for c in canon] == [
        {"kind": "LZ4HC", "level": 9}
    ]


def test_canonicalize_keeps_bare_delta_gorilla_and_drops_double_delta_size() -> None:
    # #465: ClickHouse fills in the column's value width for a bare Delta/Gorilla.
    def canon(spec: CodecSpecInput) -> list[dict[str, Any]]:
        return [c.model_dump(exclude_none=True) for c in canonicalize_codec(spec)]

    assert canon({"kind": "Delta"}) == [{"kind": "Delta"}]
    assert canon({"kind": "Delta", "size": 1}) == [{"kind": "Delta", "size": 1}]
    assert canon({"kind": "DoubleDelta", "size": 4}) == [{"kind": "DoubleDelta"}]
    assert canon({"kind": "Gorilla"}) == [{"kind": "Gorilla"}]


def test_canonicalize_keeps_a_malformed_atom_as_written() -> None:
    [step] = canonicalize_codec({"kind": "ZSTD", "level": 1.5})
    assert step.model_dump() == {"kind": "invalid", "value": {"kind": "ZSTD", "level": 1.5}}


def test_canonicalize_trims_raw_expression_whitespace() -> None:
    canon = canonicalize_codec(codec_raw("  SomeNewCodec(42)  "))
    assert [c.model_dump() for c in canon] == [
        {"kind": "raw", "expression": "SomeNewCodec(42)"}
    ]


def test_canonicalize_normalizes_single_step_to_array_form() -> None:
    canon = canonicalize_codec({"kind": "LZ4"})
    assert [c.model_dump(exclude_none=True) for c in canon] == [{"kind": "LZ4"}]


def test_canonicalize_preserves_chain_order() -> None:
    canon = canonicalize_codec(
        [{"kind": "Delta", "size": 4}, {"kind": "ZSTD", "level": 3}]
    )
    assert [c.model_dump(exclude_none=True) for c in canon] == [
        {"kind": "Delta", "size": 4},
        {"kind": "ZSTD", "level": 3},
    ]


# ───────────── codecsEqual ─────────────


def test_codecs_equal_both_none() -> None:
    assert codecs_equal(None, None) is True


def test_codecs_equal_one_none() -> None:
    assert codecs_equal(None, {"kind": "LZ4"}) is False
    assert codecs_equal({"kind": "LZ4"}, None) is False


def test_codecs_equal_zstd_vs_zstd1_compare_equal_after_canon() -> None:
    assert codecs_equal({"kind": "ZSTD"}, {"kind": "ZSTD", "level": 1}) is True


def test_codecs_equal_zstd_vs_zstd3_not_equal() -> None:
    assert codecs_equal({"kind": "ZSTD"}, {"kind": "ZSTD", "level": 3}) is False


def test_codecs_equal_single_step_vs_array_form_same_content() -> None:
    assert codecs_equal({"kind": "LZ4"}, [{"kind": "LZ4"}]) is True


def test_codecs_equal_chain_order_matters() -> None:
    a = [{"kind": "Delta", "size": 4}, {"kind": "ZSTD"}]
    b = [{"kind": "ZSTD"}, {"kind": "Delta", "size": 4}]
    assert codecs_equal(a, b) is False


# ───────────── codecFingerprint ─────────────

# Each schema codec beside the compression_codec ClickHouse 26.3 and
# ObsessionDB 26.8 store for the CREATE TABLE chkit renders from it (#383).
_STORED: list[tuple[CodecSpecInput, str]] = [
    ({"kind": "NONE"}, "CODEC(NONE)"),
    ({"kind": "LZ4"}, "CODEC(LZ4)"),
    ({"kind": "T64"}, "CODEC(T64)"),
    ([{"kind": "GCD"}, {"kind": "LZ4"}], "CODEC(GCD, LZ4)"),
    ({"kind": "ALP"}, "CODEC(ALP)"),
    ({"kind": "ZSTD"}, "CODEC(ZSTD(1))"),
    ({"kind": "ZSTD", "level": 3}, "CODEC(ZSTD(3))"),
    ({"kind": "ZSTD", "level": -1}, "CODEC(ZSTD(18446744073709551615))"),
    ({"kind": "LZ4HC"}, "CODEC(LZ4HC(9))"),
    ({"kind": "LZ4HC"}, "CODEC(LZ4HC(0))"),
    ({"kind": "LZ4HC", "level": 0}, "CODEC(LZ4HC(0))"),
    ({"kind": "LZ4HC", "level": -1}, "CODEC(LZ4HC(18446744073709551615))"),
    ({"kind": "LZ4HC", "level": 12}, "CODEC(LZ4HC(12))"),
    ([{"kind": "Delta", "size": 8}, {"kind": "LZ4"}], "CODEC(Delta(8), LZ4)"),
    ([{"kind": "DoubleDelta"}, {"kind": "LZ4"}], "CODEC(DoubleDelta, LZ4)"),
    ([{"kind": "DoubleDelta", "size": 4}, {"kind": "LZ4"}], "CODEC(DoubleDelta, LZ4)"),
    ([{"kind": "Gorilla", "size": 8}, {"kind": "ZSTD", "level": 2}], "CODEC(Gorilla(8), ZSTD(2))"),
    ([{"kind": "FPC", "level": 12, "floatSize": 8}, {"kind": "LZ4"}], "CODEC(FPC(12), LZ4)"),
    (
        [{"kind": "Delta", "size": 8}, {"kind": "T64"}, {"kind": "ZSTD"}],
        "CODEC(Delta(8), T64, ZSTD(1))",
    ),
    ([{"kind": "T64"}, {"kind": "LZ4"}], "CODEC(T64, LZ4)"),
    ([{"kind": "T64"}, {"kind": "ZSTD", "level": 3}], "CODEC(T64, ZSTD(3))"),
    ([{"kind": "Delta", "size": 8}, {"kind": "T64"}, {"kind": "LZ4"}], "CODEC(Delta(8), T64, LZ4)"),
    (
        [{"kind": "Delta", "size": 8}, {"kind": "GCD"}, {"kind": "ZSTD"}],
        "CODEC(Delta(8), GCD, ZSTD(1))",
    ),
    (codec_raw("ZSTD"), "CODEC(ZSTD(1))"),
    (codec_raw("Delta(4),ZSTD(3)"), "CODEC(Delta(4), ZSTD(3))"),
    (codec_raw("FPC, LZ4"), "CODEC(FPC(12), LZ4)"),
    (codec_raw("FPC(5, 4), LZ4HC"), "CODEC(FPC(5), LZ4HC(0))"),
    (codec_raw("AES_128_GCM_SIV"), "CODEC(AES_128_GCM_SIV)"),
    ([{"kind": "Delta", "size": 4}, codec_raw("ZSTD(3)")], "CODEC(Delta(4), ZSTD(3))"),
]


@pytest.mark.parametrize(("spec", "compression_codec"), _STORED)
def test_codec_fingerprint_matches_the_stored_form(
    spec: CodecSpecInput, compression_codec: str
) -> None:
    assert codec_fingerprint(spec) == codec_fingerprint(parse_codec(compression_codec))


def test_codec_fingerprint_of_no_codec_matches_an_empty_compression_codec() -> None:
    assert codec_fingerprint(None) == ""
    assert codec_fingerprint(parse_codec("")) == ""


def test_codec_fingerprint_tells_apart_codecs_clickhouse_stores_differently() -> None:
    distinct: list[CodecSpecInput] = [
        {"kind": "LZ4"},
        {"kind": "NONE"},
        {"kind": "ZSTD"},
        {"kind": "ZSTD", "level": 3},
        {"kind": "ZSTD", "level": 0},
        {"kind": "LZ4HC"},
        {"kind": "LZ4HC", "level": 12},
        [{"kind": "Delta", "size": 1}, {"kind": "LZ4"}],
        [{"kind": "Delta", "size": 8}, {"kind": "LZ4"}],
        [{"kind": "DoubleDelta"}, {"kind": "LZ4"}],
        [{"kind": "Gorilla", "size": 8}, {"kind": "LZ4"}],
        [{"kind": "FPC", "level": 12, "floatSize": 8}, {"kind": "LZ4"}],
        [{"kind": "FPC", "level": 5, "floatSize": 8}, {"kind": "LZ4"}],
        [{"kind": "T64"}, {"kind": "LZ4"}],
        [{"kind": "LZ4"}, {"kind": "T64"}],
    ]
    fingerprints = [codec_fingerprint(spec) for spec in distinct]
    assert len({*fingerprints, ""}) == len(distinct) + 1


def test_codec_fingerprint_matches_the_typescript_strings() -> None:
    assert codec_fingerprint({"kind": "LZ4HC"}) == "LZ4HC(9)"
    assert codec_fingerprint(parse_codec("CODEC(ZSTD(18446744073709551615))")) == "ZSTD(-1)"
    assert (
        codec_fingerprint(parse_codec("CODEC(Delta(8), DoubleDelta, FPC(12), ZSTD(1))"))
        == "Delta(8),DoubleDelta,FPC(12),ZSTD(1)"
    )


# ───────────── codec forms ClickHouse stores (#465) ─────────────


def test_render_bare_delta_gorilla_and_never_a_double_delta_size() -> None:
    assert render_codec([{"kind": "Delta"}, {"kind": "ZSTD"}]) == "CODEC(Delta, ZSTD)"
    assert render_codec({"kind": "Gorilla"}) == "CODEC(Gorilla)"
    assert render_codec({"kind": "DoubleDelta", "size": 8}) == "CODEC(DoubleDelta)"


def test_render_and_parse_zstd_window_t64_mode_fpc_level_and_default() -> None:
    forms: list[tuple[CodecSpecInput, str]] = [
        ({"kind": "ZSTD", "level": 3, "windowLog": 24}, "CODEC(ZSTD(3, 24))"),
        ({"kind": "T64", "mode": "bit"}, "CODEC(T64('bit'))"),
        ({"kind": "FPC"}, "CODEC(FPC)"),
        ({"kind": "FPC", "level": 12}, "CODEC(FPC(12))"),
        ([{"kind": "Delta"}, {"kind": "Default"}], "CODEC(Delta, Default)"),
    ]
    for spec, sql in forms:
        assert render_codec(spec) == sql
        parsed = parse_codec(sql)
        assert parsed is not None
        expected = spec if isinstance(spec, list) else [spec]
        assert [c.model_dump(by_alias=True, exclude_none=True) for c in parsed] == expected
    t64 = parse_codec("CODEC(T64('byte'))")
    assert t64 is not None
    assert [c.model_dump(exclude_none=True) for c in t64] == [{"kind": "T64", "mode": "byte"}]


def test_codec_fingerprint_fills_in_the_value_width_for_bare_delta_or_gorilla() -> None:
    widths: list[tuple[str, CodecSpecInput, str]] = [
        ("UInt64", [{"kind": "Delta"}, {"kind": "ZSTD"}], "CODEC(Delta(8), ZSTD(1))"),
        ("UInt32", [{"kind": "Delta"}, {"kind": "ZSTD"}], "CODEC(Delta(4), ZSTD(1))"),
        ("Date", [{"kind": "Delta"}, {"kind": "ZSTD"}], "CODEC(Delta(2), ZSTD(1))"),
        ("DateTime64(3, 'UTC')", [{"kind": "Delta"}, {"kind": "ZSTD"}], "CODEC(Delta(8), ZSTD(1))"),
        ("Nullable(UInt64)", [{"kind": "Delta"}, {"kind": "LZ4"}], "CODEC(Delta(8), LZ4)"),
        ("Array(Float64)", {"kind": "Gorilla"}, "CODEC(Gorilla(8))"),
        ("Float32", {"kind": "Gorilla"}, "CODEC(Gorilla(4))"),
        ("Tuple(a UInt8, b UInt64)", [{"kind": "Delta"}, {"kind": "LZ4"}], "CODEC(Delta, LZ4)"),
        ("Map(UInt32, UInt32)", [{"kind": "Delta"}, {"kind": "LZ4"}], "CODEC(Delta(4), LZ4)"),
        ("UInt64", codec_raw("Delta, Default"), "CODEC(Delta(8), Default)"),
        ("UInt64", [{"kind": "Delta", "size": 4}, {"kind": "ZSTD"}], "CODEC(Delta(4), ZSTD(1))"),
    ]
    for type_, spec, stored in widths:
        assert codec_fingerprint(spec, type_) == codec_fingerprint(parse_codec(stored), type_)
    # An explicit size is compared as written: no equivalence with the bare form.
    assert not codecs_equal({"kind": "Delta", "size": 1}, {"kind": "Delta"}, "UInt64")
    assert codecs_equal({"kind": "Delta", "size": 8}, {"kind": "Delta"}, "UInt64")


def test_codec_fingerprint_compares_respelled_codecs_equal() -> None:
    same: list[tuple[str, CodecSpecInput, CodecSpecInput]] = [
        ("String", {"kind": "ZSTD"}, {"kind": "ZSTD", "level": 1}),
        ("String", {"kind": "LZ4HC"}, {"kind": "LZ4HC", "level": 9}),
        ("UInt64", {"kind": "DoubleDelta", "size": 8}, {"kind": "DoubleDelta"}),
        ("Float64", {"kind": "FPC", "level": 12, "floatSize": 8}, {"kind": "FPC", "level": 12, "floatSize": 4}),
        ("Float64", {"kind": "FPC", "level": 12, "floatSize": 4}, {"kind": "FPC"}),
        ("String", [{"kind": "LZ4"}], {"kind": "LZ4"}),
        ("String", codec_raw("NONE"), {"kind": "NONE"}),
        ("String", codec_raw("ZSTD"), {"kind": "ZSTD", "level": 1}),
        ("String", codec_raw("ZSTD, AES_128_GCM_SIV"), codec_raw("ZSTD(1), AES_128_GCM_SIV")),
        ("UInt64", {"kind": "T64", "mode": "byte"}, {"kind": "T64"}),
        # Integer literals ClickHouse reads: hex, binary, underscores.
        ("String", codec_raw("ZSTD(0x1)"), {"kind": "ZSTD", "level": 1}),
        ("String", codec_raw("ZSTD(1_0)"), {"kind": "ZSTD", "level": 10}),
        ("String", codec_raw("ZSTD(3, 0x18)"), {"kind": "ZSTD", "level": 3, "windowLog": 24}),
        ("String", codec_raw("LZ4HC(0b1_0)"), {"kind": "LZ4HC", "level": 2}),
        ("UInt64", codec_raw("T64( 'bit' )"), {"kind": "T64", "mode": "bit"}),
        # ClickHouse keeps the low 32 bits of an LZ4HC level (observed on 26.3).
        ("String", {"kind": "LZ4HC", "level": 4294967297}, parse_codec("CODEC(LZ4HC(1))") or []),
        (
            "String",
            codec_raw("LZ4HC(2147483648)"),
            parse_codec("CODEC(LZ4HC(18446744071562067968))") or [],
        ),
    ]
    for type_, a, b in same:
        assert codec_fingerprint(a, type_) == codec_fingerprint(b, type_)


def test_codec_fingerprint_tells_apart_a_zstd_window_and_a_t64_bit_mode() -> None:
    assert codec_fingerprint({"kind": "ZSTD", "level": 3, "windowLog": 24}) != codec_fingerprint(
        {"kind": "ZSTD", "level": 3}
    )
    assert codec_fingerprint({"kind": "T64", "mode": "bit"}) != codec_fingerprint({"kind": "T64"})


def test_codec_fingerprint_leaves_a_decimal_argument_too_long_for_a_number_unparsed() -> None:
    expression = "ZSTD(-" + "9" * 4301 + ")"
    assert codec_fingerprint(codec_raw(expression)) == expression


def test_codec_fingerprint_keeps_whitespace_inside_a_quoted_argument() -> None:
    # ClickHouse rejects T64('b it').
    assert codec_fingerprint(codec_raw("T64('b it')")) == "T64('b it')"


# Schema and compression_codec pairs observed on ClickHouse 26.3.
_MATRIX_STORED: list[tuple[str, CodecSpecInput, str]] = [
    ('SimpleAggregateFunction(sum, UInt64)', [{'kind': 'Delta'}, {'kind': 'LZ4'}], 'CODEC(Delta(8), LZ4)'),
    ('SimpleAggregateFunction(max, DateTime)', [{'kind': 'Delta'}, {'kind': 'LZ4'}], 'CODEC(Delta(4), LZ4)'),
    ('SimpleAggregateFunction(max, Float64)', {'kind': 'Gorilla'}, 'CODEC(Gorilla(8))'),
    ('SimpleAggregateFunction(max, Float32)', {'kind': 'FPC'}, 'CODEC(FPC(12))'),
    ('SimpleAggregateFunction(sum, UInt64)', {'kind': 'T64'}, 'CODEC(T64)'),
    ('SimpleAggregateFunction(sum, UInt64)', {'kind': 'DoubleDelta'}, 'CODEC(DoubleDelta)'),
    ('SimpleAggregateFunction(max, Nullable(UInt16))', [{'kind': 'Delta'}, {'kind': 'LZ4'}], 'CODEC(Delta(2), LZ4)'),
    ('SimpleAggregateFunction(groupUniqArrayArray, Array(UInt32))', [{'kind': 'Delta'}, {'kind': 'LZ4'}], 'CODEC(Delta(4), LZ4)'),
    ("Enum('a' = 1, 'b' = 2)", [{'kind': 'Delta'}, {'kind': 'LZ4'}], 'CODEC(Delta(1), LZ4)'),
    ("Enum('a' = 1, 'b' = 1000)", [{'kind': 'Delta'}, {'kind': 'LZ4'}], 'CODEC(Delta(2), LZ4)'),
    ("Enum16('a' = 1)", [{'kind': 'Delta'}, {'kind': 'LZ4'}], 'CODEC(Delta(2), LZ4)'),
    ('Tuple(Float32, Float64)', [{'kind': 'Gorilla'}, {'kind': 'FPC', 'level': 12, 'floatSize': 4}], 'CODEC(Gorilla, FPC(12, 4))'),
    ('Tuple(Float32, Float64)', {'kind': 'FPC', 'level': 12, 'floatSize': 4}, 'CODEC(FPC(12))'),
    ('Tuple(Float32, Float64)', {'kind': 'FPC', 'level': 12}, 'CODEC(FPC(12))'),
    ('Tuple(Float32, Float64)', {'kind': 'FPC'}, 'CODEC(FPC(12))'),
    ('Tuple(Float32, Float64)', [{'kind': 'FPC', 'level': 12, 'floatSize': 4}, {'kind': 'ZSTD'}], 'CODEC(FPC(12), ZSTD(1))'),
    ('Tuple(Float32, Float64)', {'kind': 'Gorilla'}, 'CODEC(Gorilla)'),
    ('Tuple(Float32, Float64)', {'kind': 'Gorilla', 'size': 4}, 'CODEC(Gorilla(4))'),
    ('Tuple(Float32, Float64)', [{'kind': 'Gorilla'}, {'kind': 'ZSTD'}], 'CODEC(Gorilla, ZSTD)'),
    ('Tuple(Float64, Float64)', [{'kind': 'Gorilla'}, {'kind': 'FPC', 'level': 12, 'floatSize': 4}], 'CODEC(Gorilla(8), FPC(12))'),
    ('Tuple(Float64, Float64)', {'kind': 'FPC', 'level': 12, 'floatSize': 4}, 'CODEC(FPC(12))'),
    ('Tuple(UInt32, UInt64)', [{'kind': 'Delta'}, {'kind': 'ZSTD'}], 'CODEC(Delta, ZSTD)'),
    ('Tuple(UInt32, UInt64)', [{'kind': 'Delta', 'size': 2}, {'kind': 'ZSTD'}], 'CODEC(Delta(2), ZSTD(1))'),
    ('Array(Tuple(Float32, Float64))', [{'kind': 'Gorilla'}, {'kind': 'FPC', 'level': 12, 'floatSize': 4}], 'CODEC(Gorilla, FPC(12, 4))'),
    ('Tuple(Float32, Float64)', [{'kind': 'DoubleDelta'}, {'kind': 'ZSTD'}], 'CODEC(DoubleDelta, ZSTD)'),
    ('Tuple(Float32, Float64)', {'kind': 'ALP'}, 'CODEC(ALP)'),
    ('String', [{'kind': 'Delta', 'size': 4}, {'kind': 'LZ4'}], 'CODEC(Delta(4), LZ4)'),
    ('String', [{'kind': 'Delta', 'size': 1}, {'kind': 'LZ4'}], 'CODEC(Delta(1), LZ4)'),
    ('FixedString(4)', [{'kind': 'Delta', 'size': 4}, {'kind': 'LZ4'}], 'CODEC(Delta(4), LZ4)'),
    ('Array(String)', [{'kind': 'Delta', 'size': 4}, {'kind': 'LZ4'}], 'CODEC(Delta(4), LZ4)'),
    ('Nullable(String)', [{'kind': 'Delta', 'size': 4}, {'kind': 'LZ4'}], 'CODEC(Delta(4), LZ4)'),
    ('LowCardinality(String)', [{'kind': 'Delta', 'size': 4}, {'kind': 'LZ4'}], 'CODEC(Delta(4), LZ4)'),
    ('UUID', [{'kind': 'Delta', 'size': 8}, {'kind': 'LZ4'}], 'CODEC(Delta(8), LZ4)'),
    ('Decimal(18, 4)', [{'kind': 'Delta', 'size': 8}, {'kind': 'LZ4'}], 'CODEC(Delta(8), LZ4)'),
    ('Float64', [{'kind': 'Delta', 'size': 8}, {'kind': 'LZ4'}], 'CODEC(Delta(8), LZ4)'),
    ('Tuple(UInt64, Float64)', {'kind': 'Gorilla'}, 'CODEC(Gorilla(8))'),
    ('Tuple(UInt64, Float64)', {'kind': 'Gorilla', 'size': 8}, 'CODEC(Gorilla(8))'),
    ('Array(Tuple(UInt64, Float64))', {'kind': 'Gorilla'}, 'CODEC(Gorilla(8))'),
    ('UInt64', {'kind': 'ZSTD', 'level': 3, 'windowLog': 0}, 'CODEC(ZSTD(3, 0))'),
    ('UInt64', {'kind': 'ZSTD', 'level': 3, 'windowLog': 10}, 'CODEC(ZSTD(3, 10))'),
    ('UInt64', {'kind': 'ZSTD', 'level': 3, 'windowLog': 31}, 'CODEC(ZSTD(3, 31))'),
    ('UInt64', {'kind': 'ZSTD', 'level': 1, 'windowLog': 0}, 'CODEC(ZSTD(1, 0))'),
    ('UInt64', {'kind': 'ZSTD', 'level': -1, 'windowLog': 0}, 'CODEC(ZSTD(18446744073709551615, 0))'),
    ('UInt64', {'kind': 'ZSTD', 'level': 0, 'windowLog': 0}, 'CODEC(ZSTD(0, 0))'),
    ('Tuple(Float32, Float64)', [{'kind': 'Gorilla', 'size': 4}, {'kind': 'FPC', 'level': 12, 'floatSize': 4}], 'CODEC(Gorilla(4), FPC(12))'),
    ('Tuple(Float32, Float64)', [{'kind': 'Gorilla'}, {'kind': 'FPC'}], 'CODEC(Gorilla, FPC)'),
    ('Tuple(Float32, Float64)', [{'kind': 'Gorilla'}, {'kind': 'FPC', 'level': 12, 'floatSize': 4}, {'kind': 'ZSTD'}], 'CODEC(Gorilla, FPC(12, 4), ZSTD)'),
    ('Tuple(Float32, Float64)', [{'kind': 'Gorilla'}, {'kind': 'LZ4HC'}], 'CODEC(Gorilla, LZ4HC)'),
    ('Tuple(Float32, Float64)', [{'kind': 'Gorilla'}, {'kind': 'ZSTD', 'level': 3, 'windowLog': 24}], 'CODEC(Gorilla, ZSTD(3, 24))'),
    ('Tuple(UInt32, UInt64)', [{'kind': 'Delta'}, {'kind': 'LZ4HC'}], 'CODEC(Delta, LZ4HC)'),
    ('Tuple(UInt32, UInt64)', [{'kind': 'Delta'}, {'kind': 'T64'}], 'CODEC(Delta, T64)'),
    ('Tuple(UInt32, UInt64)', [{'kind': 'DoubleDelta'}, {'kind': 'Delta'}, {'kind': 'ZSTD'}], 'CODEC(DoubleDelta, Delta, ZSTD)'),
    ('Tuple(UInt32, UInt64)', [{'kind': 'Delta'}, {'kind': 'DoubleDelta', 'size': 4}], 'CODEC(Delta, DoubleDelta(4))'),
    ('Tuple(Float32, Float64)', [{'kind': 'FPC', 'level': 12, 'floatSize': 4}, {'kind': 'Gorilla'}], 'CODEC(FPC(12, 4), Gorilla)'),
    ('Map(UInt32, UInt64)', [{'kind': 'Delta'}, {'kind': 'ZSTD'}], 'CODEC(Delta, ZSTD)'),
    ('Tuple(UInt32, Float32)', [{'kind': 'Delta'}, {'kind': 'ZSTD'}], 'CODEC(Delta(4), ZSTD(1))'),
    ('Tuple(UInt64, Float64)', [{'kind': 'Gorilla'}, {'kind': 'ZSTD'}], 'CODEC(Gorilla(8), ZSTD(1))'),
    ('Nullable(Float64)', [{'kind': 'Gorilla'}, {'kind': 'FPC', 'level': 12, 'floatSize': 4}], 'CODEC(Gorilla(8), FPC(12))'),
    ('Array(Float32)', [{'kind': 'Gorilla'}, {'kind': 'FPC', 'level': 12, 'floatSize': 8}], 'CODEC(Gorilla(4), FPC(12))'),
]


@pytest.mark.parametrize(("type_", "spec", "stored"), _MATRIX_STORED)
def test_server_matrix_stored_forms(type_: str, spec: CodecSpecInput, stored: str) -> None:
    expected = codec_fingerprint(parse_codec(stored), type_)
    assert codec_fingerprint(spec, type_) == expected
    assert codec_fingerprint(codec_raw(render_codec(spec)[6:-1]), type_) == expected


def test_mixed_widths_retain_fpc_arguments_and_unknown_types_keep_the_old_comparison() -> None:
    before: CodecSpecInput = [{"kind": "Gorilla"}, {"kind": "FPC", "level": 12, "floatSize": 4}]
    after: CodecSpecInput = [{"kind": "Gorilla"}, {"kind": "FPC", "level": 12, "floatSize": 8}]
    assert codec_fingerprint(before, "Tuple(Float32, Float64)") == "Gorilla,FPC(12,4)"
    assert not codecs_equal(before, after, "Tuple(Float32, Float64)")
    assert codecs_equal(before, after, "JSON")
    assert codecs_equal(before, after, "Dynamic")


def test_zero_zstd_window_remains_distinct_from_an_omitted_window() -> None:
    assert codec_fingerprint({"kind": "ZSTD", "level": 3, "windowLog": 0}) == "ZSTD(3,0)"
    assert not codecs_equal(
        {"kind": "ZSTD", "level": 3, "windowLog": 0}, {"kind": "ZSTD", "level": 3}
    )


# Parser coverage beyond the server matrix; these are not server verdicts.
@pytest.mark.parametrize(("type_", "expected"), [
    ("Enum('can\\'t' = 1000, 'b' = 1)", "Delta(2),LZ4"),
    ("Enum('a\\', b' = 1, 'c' = 2)", "Delta(1),LZ4"),
    ("Enum('a' = \u0661)", "Delta,LZ4"),
    ("Enum('a' = 1\u0085)", "Delta,LZ4"),
    ("Enum('a' = 0x1)", "Delta,LZ4"),
    ("Enum('a' = " + "9" * 4301 + ")", "Delta(2),LZ4"),
])
def test_enum_value_parsing_parity(type_: str, expected: str) -> None:
    assert codec_fingerprint([{"kind": "Delta"}, {"kind": "LZ4"}], type_) == expected
