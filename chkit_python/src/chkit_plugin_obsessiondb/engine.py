"""Auto-rewrite ``Shared*`` engines + strip cloud-only settings.

1:1 port of ``rewriteSharedEngines`` / ``stripCloudSettings`` /
``isObsessionDBHost`` / ``resolveStripBehavior`` from
``packages/plugin-obsessiondb/src/index.ts``.

Why:

- ObsessionDB's managed engines are named ``SharedMergeTree`` etc.
  These DDL names only work on ObsessionDB.
- A user may author schemas with ``Shared*`` engines and then ``chkit
  migrate`` against a vanilla ClickHouse (Docker, dev box, on-prem).
- Without auto-rewrite, the migration would fail with "unknown
  engine".

The hook auto-detects the target via URL pattern. The user can override
with ``--force-shared-engines`` (keep them) or ``--no-shared-engines``
(always strip).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from chkit.core.model import (
    ChxResolvedConfig,
    SchemaDefinition,
    TableDefinition,
)

# Settings ClickHouse accepts only on managed/cloud instances. They're
# silently stripped when targeting bare CH because they'd raise "Unknown
# setting" otherwise.
_CLOUD_ONLY_SETTINGS: tuple[str, ...] = ("storage_policy",)

_OBSESSIONDB_DOMAINS: tuple[str, ...] = (
    "obsessiondb.com",
    "obsession.numia-dev.com",
)


@dataclass(frozen=True, slots=True)
class StripCloudSettingsResult:
    settings: dict[str, str | int | float | bool] | None
    stripped: list[str]


@dataclass(frozen=True, slots=True)
class RewriteSharedEnginesResult:
    definitions: list[SchemaDefinition]
    count: int
    stripped_settings: list[str]


def is_obsessiondb_host(url: str) -> bool:
    """Return True when ``url``'s hostname matches a known ObsessionDB domain."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        return False
    return any(
        hostname == base or hostname.endswith(f".{base}")
        for base in _OBSESSIONDB_DOMAINS
    )


def resolve_strip_behavior(
    config: ChxResolvedConfig, flags: dict[str, Any]
) -> bool:
    """Should the hook strip ``Shared*`` prefixes for this command?

    Priority: ``--force-shared-engines`` (don't strip) >
    ``--no-shared-engines`` (always strip) > URL auto-detect.
    """
    if flags.get("force_shared_engines") or flags.get("--force-shared-engines"):
        return False
    if flags.get("no_shared_engines") or flags.get("--no-shared-engines"):
        return True
    url = config.clickhouse.url if config.clickhouse is not None else None
    return not (url and is_obsessiondb_host(url))


def strip_shared_prefix(engine: str) -> str:
    """``SharedMergeTree`` → ``MergeTree``. No-op for non-Shared engines."""
    if engine.startswith("Shared"):
        return engine[len("Shared") :]
    return engine


def strip_cloud_settings(
    settings: dict[str, str | int | float | bool] | None,
) -> StripCloudSettingsResult:
    """Remove cloud-only settings; return the cleaned dict + list of dropped keys."""
    if settings is None:
        return StripCloudSettingsResult(settings=None, stripped=[])

    stripped: list[str] = []
    result: dict[str, str | int | float | bool] | None = None
    for key in _CLOUD_ONLY_SETTINGS:
        if key in settings:
            if result is None:
                result = dict(settings)
            del result[key]
            stripped.append(key)

    if result is None:
        return StripCloudSettingsResult(settings=settings, stripped=[])
    return StripCloudSettingsResult(
        settings=result if result else None,
        stripped=stripped,
    )


def rewrite_shared_engines(
    definitions: Sequence[SchemaDefinition],
) -> RewriteSharedEnginesResult:
    """Rewrite each ``TableDefinition``: strip ``Shared`` + cloud settings."""
    count = 0
    all_stripped: list[str] = []
    rewritten: list[SchemaDefinition] = []

    for definition in definitions:
        if not isinstance(definition, TableDefinition):
            rewritten.append(definition)
            continue

        has_shared = definition.engine.startswith("Shared")
        cleaned = strip_cloud_settings(definition.settings)
        all_stripped.extend(cleaned.stripped)

        if not has_shared and not cleaned.stripped:
            rewritten.append(definition)
            continue

        if has_shared:
            count += 1
        rewritten.append(
            definition.model_copy(
                update={
                    "engine": (
                        strip_shared_prefix(definition.engine)
                        if has_shared
                        else definition.engine
                    ),
                    "settings": cleaned.settings,
                }
            )
        )

    return RewriteSharedEnginesResult(
        definitions=rewritten,
        count=count,
        stripped_settings=all_stripped,
    )
