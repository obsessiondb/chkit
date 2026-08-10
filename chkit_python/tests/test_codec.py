"""Codec parse/render/canonicalize round-trips."""

from __future__ import annotations

from chkit.core.codec import (
    canonicalize_codec,
    codecs_equal,
    parse_codec,
    render_codec,
)


def test_render_simple_general_codec() -> None:
    parsed = parse_codec("CODEC(LZ4)")
    assert parsed is not None
    assert len(parsed) == 1
    assert render_codec(parsed) == "CODEC(LZ4)"


def test_render_zstd_with_level() -> None:
    parsed = parse_codec("CODEC(ZSTD(3))")
    assert parsed is not None
    assert render_codec(parsed) == "CODEC(ZSTD(3))"


def test_canonicalize_zstd_default_level() -> None:
    canon = canonicalize_codec(parse_codec("CODEC(ZSTD)") or [])
    rendered = parse_codec("CODEC(ZSTD(1))")
    assert rendered is not None
    assert [c.model_dump() for c in canon] == [c.model_dump() for c in canonicalize_codec(rendered)]


def test_codec_chain_delta_zstd() -> None:
    parsed = parse_codec("CODEC(Delta(4), ZSTD(1))")
    assert parsed is not None
    assert render_codec(parsed) == "CODEC(Delta(4), ZSTD(1))"


def test_unknown_codec_falls_back_to_raw() -> None:
    parsed = parse_codec("CODEC(MysteryCodec(7,8))")
    assert parsed is not None
    assert len(parsed) == 1
    assert parsed[0].kind == "raw"


def test_codecs_equal_ignores_default_filling() -> None:
    a = parse_codec("CODEC(ZSTD)")
    b = parse_codec("CODEC(ZSTD(1))")
    assert a is not None
    assert b is not None
    assert codecs_equal(a, b) is True
