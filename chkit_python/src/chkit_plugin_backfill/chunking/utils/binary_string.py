"""Binary-string boundary math over JS ``latin1`` semantics.

1:1 port of ``chunking/utils/binary-string.ts``. JS ``Buffer.from(s, 'latin1')``
takes each UTF-16 code unit masked with ``& 0xFF`` — replicated here by
encoding to UTF-16-LE and keeping every low byte, so astral characters
(surrogate pairs in JS) also round-trip identically. ``buffer.toString('latin1')``
maps bytes to U+0000..U+00FF, which is exactly ``bytes.decode('latin-1')``.
"""

from __future__ import annotations


def latin1_bytes(value: str) -> bytes:
    """Replicate JS ``Buffer.from(value, 'latin1')``."""
    return value.encode("utf-16-le", "surrogatepass")[::2]


def latin1_str(data: bytes) -> str:
    """Replicate JS ``buffer.toString('latin1')``."""
    return data.decode("latin-1")


def compare_binary_strings(left: str, right: str) -> int:
    left_bytes = latin1_bytes(left)
    right_bytes = latin1_bytes(right)
    if left_bytes < right_bytes:
        return -1
    if left_bytes > right_bytes:
        return 1
    return 0


def min_binary_string(left: str, right: str) -> str:
    return left if compare_binary_strings(left, right) <= 0 else right


def max_binary_string(left: str, right: str) -> str:
    return left if compare_binary_strings(left, right) >= 0 else right


def next_prefix_value(prefix: str) -> str | None:
    if len(prefix) == 0:
        return None

    buffer = bytearray(latin1_bytes(prefix))
    for index in range(len(buffer) - 1, -1, -1):
        byte = buffer[index]
        if byte == 0xFF:  # noqa: PLR2004 — max byte value
            continue
        nxt = bytearray(buffer[: index + 1])
        nxt[index] = byte + 1
        return latin1_str(bytes(nxt))

    return None


def build_observed_string_upper_bound(max_value: str) -> str:
    return f"{max_value}\0"


def str_to_big_int(value: str, pad_to: int) -> int:
    buffer = latin1_bytes(value)
    result = 0
    for index in range(pad_to):
        byte = buffer[index] if index < len(buffer) else 0
        result = (result << 8) | byte
    return result


def big_int_to_str(value: int, length: int, min_length: int = 0) -> str:
    buffer = bytearray(length)
    remaining = value
    for index in range(length - 1, -1, -1):
        buffer[index] = remaining & 0xFF
        remaining >>= 8

    # Strip trailing null bytes so boundaries match real string values
    # in ClickHouse comparisons (where "abc" < "abc\0"), but preserve
    # at least min_length bytes to avoid losing meaningful trailing nulls
    # (e.g. from build_observed_string_upper_bound which appends "\0").
    end = length
    while end > min_length and buffer[end - 1] == 0:
        end -= 1

    return latin1_str(bytes(buffer[:end]))


__all__ = [
    "big_int_to_str",
    "build_observed_string_upper_bound",
    "compare_binary_strings",
    "latin1_bytes",
    "latin1_str",
    "max_binary_string",
    "min_binary_string",
    "next_prefix_value",
    "str_to_big_int",
]
