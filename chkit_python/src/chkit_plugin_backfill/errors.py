"""Backfill plugin errors. 1:1 port of ``packages/plugin-backfill/src/errors.ts``."""

from __future__ import annotations


class BackfillConfigError(Exception):
    """Raised on invalid options, missing plans, environment mismatches, etc."""


__all__ = ["BackfillConfigError"]
