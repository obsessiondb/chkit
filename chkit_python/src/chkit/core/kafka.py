"""Kafka engine recognition and literal settings, matching the TypeScript core."""

from __future__ import annotations

import re

from chkit.core.key_clause import split_top_level_comma


def is_kafka_engine(engine: str) -> bool:
    return re.match(r"^Kafka\s*(?:\(|$)", engine.strip(), re.IGNORECASE) is not None


def render_kafka_setting(value: str | int | float | bool) -> str:
    if isinstance(value, str):
        escaped = value.replace("\\", "\\\\").replace("'", "''")
        return f"'{escaped}'"
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value)


def parse_kafka_setting(value: str) -> str | int | float | bool:
    trimmed = value.strip()
    if trimmed.startswith("'") and trimmed.endswith("'"):
        escapes: dict[str, str] = {
            "n": "\n",
            "r": "\r",
            "t": "\t",
            "b": "\b",
            "f": "\f",
            "a": "\a",
            "v": "\v",
            "0": "\0",
            "N": "",
            "\\": "\\",
            "'": "'",
            '"': '"',
        }
        data = bytearray()
        tokens: list[str] = re.findall(r"\\x[\da-fA-F]{2}|\\[\s\S]|''|[\s\S]", trimmed[1:-1])
        for token in tokens:
            if re.fullmatch(r"\\x[\da-fA-F]{2}", token):
                data.append(int(token[2:], 16))
            else:
                decoded = token
                if token == "''":
                    decoded = "'"
                elif token.startswith("\\"):
                    decoded = escapes.get(token[1:], token)
                data.extend(decoded.encode("utf-8"))
        return data.decode("utf-8", errors="replace")
    if trimmed.lower() in {"true", "false"}:
        return trimmed.lower() == "true"
    if re.fullmatch(r"-?\d+", trimmed):
        return int(trimmed)
    return trimmed


def parse_kafka_settings(settings: dict[str, str]) -> dict[str, str | int | float | bool]:
    return {key: parse_kafka_setting(value) for key, value in settings.items()}


def kafka_setting_fingerprint(value: str | int | float | bool) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def normalize_kafka_engine(engine: str) -> str:
    match = re.fullmatch(r"Kafka\s*\(([\s\S]*)\)", engine.strip(), re.IGNORECASE)
    args = split_top_level_comma(match.group(1) if match else "")
    normalized = [
        render_kafka_setting(parse_kafka_setting(arg)) if arg.startswith("'") else arg.strip()
        for arg in args
    ]
    return f"Kafka({', '.join(normalized)})"
