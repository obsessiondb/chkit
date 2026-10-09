"""JS ``Date`` parity helpers for the chunking planner.

The TS planner does boundary math on epoch milliseconds
(``Date.parse`` / ``new Date(ms).toISOString()``). These helpers pin the same
semantics: millisecond precision, always-UTC ISO output with a trailing ``Z``.
"""

from __future__ import annotations

from datetime import UTC, datetime


def parse_planner_datetime(value: str) -> int:
    """Port of ``parsePlannerDateTime`` — epoch milliseconds.

    Mirrors the TS normalisation: insert ``T`` when missing, append ``Z``
    unless already present, then parse as an ISO instant.
    """
    normalized = value if "T" in value else value.replace(" ", "T", 1)
    if not normalized.endswith("Z"):
        normalized = f"{normalized}Z"
    parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    # JS Date.parse TRUNCATES fraction digits beyond milliseconds; rounding
    # here would shift boundaries by 1ms for DateTime64(>3) values.
    seconds = int(parsed.replace(microsecond=0).timestamp())
    return seconds * 1000 + parsed.microsecond // 1000


def iso_from_epoch_ms(epoch_ms: float) -> str:
    """Port of ``new Date(ms).toISOString()`` — millisecond precision + ``Z``."""
    ms = int(epoch_ms)
    # Split into integral parts to avoid float rounding at ms boundaries.
    seconds, millis = divmod(ms, 1000)
    stamp = datetime.fromtimestamp(seconds, tz=UTC)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{millis:03d}Z"


def parse_planner_datetime_to_iso(value: str) -> str:
    """``new Date(value).toISOString()`` for already-normalised inputs."""
    return iso_from_epoch_ms(parse_planner_datetime(value))


__all__ = [
    "iso_from_epoch_ms",
    "parse_planner_datetime",
    "parse_planner_datetime_to_iso",
]
