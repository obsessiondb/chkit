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


def test_parse_general_codecs_bare() -> None:
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
        "CODEC(ZSTD(3, 1))": "ZSTD(3, 1)",
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
    assert [c.model_dump() for c in zstd] == [{"kind": "ZSTD", "level": -1}]
    assert [c.model_dump() for c in lz4hc] == [{"kind": "LZ4HC", "level": -2}]


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


def test_canonicalize_fills_in_delta_double_delta_gorilla_default_size() -> None:
    for kind in ["Delta", "DoubleDelta", "Gorilla"]:
        canon = canonicalize_codec({"kind": kind})
        assert [c.model_dump(exclude_none=True) for c in canon] == [
            {"kind": kind, "size": 1}
        ]


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
    ({"kind": "GCD"}, "CODEC(GCD)"),
    ({"kind": "ALP"}, "CODEC(ALP)"),
    ({"kind": "ZSTD"}, "CODEC(ZSTD(1))"),
    ({"kind": "ZSTD", "level": 3}, "CODEC(ZSTD(3))"),
    ({"kind": "ZSTD", "level": -1}, "CODEC(ZSTD(18446744073709551615))"),
    ({"kind": "LZ4HC"}, "CODEC(LZ4HC(9))"),
    ({"kind": "LZ4HC"}, "CODEC(LZ4HC(0))"),
    ({"kind": "LZ4HC", "level": 0}, "CODEC(LZ4HC(0))"),
    ({"kind": "LZ4HC", "level": -1}, "CODEC(LZ4HC(18446744073709551615))"),
    ({"kind": "LZ4HC", "level": 12}, "CODEC(LZ4HC(12))"),
    ([{"kind": "Delta"}, {"kind": "ZSTD"}], "CODEC(Delta(1), ZSTD(1))"),
    ([{"kind": "Delta", "size": 8}, {"kind": "LZ4"}], "CODEC(Delta(8), LZ4)"),
    ([{"kind": "DoubleDelta"}, {"kind": "LZ4"}], "CODEC(DoubleDelta, LZ4)"),
    ([{"kind": "DoubleDelta", "size": 4}, {"kind": "LZ4"}], "CODEC(DoubleDelta, LZ4)"),
    ([{"kind": "Gorilla"}, {"kind": "LZ4"}], "CODEC(Gorilla(1), LZ4)"),
    ([{"kind": "Gorilla", "size": 8}, {"kind": "ZSTD", "level": 2}], "CODEC(Gorilla(8), ZSTD(2))"),
    ([{"kind": "FPC", "level": 12, "floatSize": 8}, {"kind": "LZ4"}], "CODEC(FPC(12), LZ4)"),
    (
        [{"kind": "Delta", "size": 8}, {"kind": "T64"}, {"kind": "ZSTD"}],
        "CODEC(Delta(8), T64, ZSTD(1))",
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
