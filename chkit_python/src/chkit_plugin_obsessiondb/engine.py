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

from chkit.core.engine import is_distributed_engine, is_merge_tree_engine
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
    """Should the hook strip ObsessionDB settings such as storage_policy?

    Priority: ``--force-shared-engines`` (don't strip) >
    ``--no-shared-engines`` (always strip) > URL auto-detect. Parsed flags
    keep their ``--`` prefix (TS ``parseFlags``); the unprefixed snake_case
    keys are accepted too.
    """
    if flags.get("force_shared_engines") or flags.get("--force-shared-engines"):
        return False
    if flags.get("no_shared_engines") or flags.get("--no-shared-engines"):
        return True
    url = config.clickhouse.url if config.clickhouse is not None else None
    return not (url and is_obsessiondb_host(url))


def find_distributed_tables(definitions: Sequence[SchemaDefinition]) -> list[str]:
    """One message per Distributed table, so generate and check fail early.

    ObsessionDB runs one shared-storage service with no shards, and its users
    have no grant for the Distributed engine. Port of ``findDistributedTables``.
    """
    return [
        f"Table {definition.database}.{definition.name} uses the Distributed engine, "
        "which ObsessionDB does not support: ObsessionDB has no shards, so every "
        "replica already reads the same shared storage. Remove the Distributed table "
        "from the schema and query or insert into its local table directly."
        for definition in definitions
        if isinstance(definition, TableDefinition) and is_distributed_engine(definition.engine)
    ]


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


_OBSESSIONDB_STORAGE_POLICY = "'s3'"


def is_obsessiondb_target(config: ChxResolvedConfig, flags: dict[str, Any]) -> bool:
    """A target the plugin knows is ObsessionDB: an ObsessionDB host, not forced
    to strip (TS ``isObsessionDBTarget``). ``--force-shared-engines`` on another
    host may be a self-hosted server with its own policies, so it keeps
    storage_policy without these rules."""
    url = config.clickhouse.url if config.clickhouse is not None else None
    if resolve_strip_behavior(config, flags) or not url:
        return False
    return is_obsessiondb_host(url)


def with_obsessiondb_storage_policy(
    definitions: Sequence[SchemaDefinition],
) -> list[SchemaDefinition]:
    """ObsessionDB writes ``storage_policy = 's3'`` into every Shared table, the
    only policy such a table can have, so a table that does not declare it has
    it, and pull reads it back. On an ObsessionDB target the schema and the
    snapshot both get it, so neither plans a change against the other (TS
    ``withObsessionDBStoragePolicy``, #466)."""
    out: list[SchemaDefinition] = []
    for definition in definitions:
        if (
            not isinstance(definition, TableDefinition)
            or not is_merge_tree_engine(definition.engine)
            or (definition.settings is not None and "storage_policy" in definition.settings)
        ):
            out.append(definition)
            continue
        settings = {**(definition.settings or {}), "storage_policy": _OBSESSIONDB_STORAGE_POLICY}
        out.append(definition.model_copy(update={"settings": settings}))
    return out


def storage_policy_change_errors(plan: Any) -> list[str]:
    """ObsessionDB rejects any other storage_policy on a Shared table, so on an
    ObsessionDB target a plan that changes it fails in generate, with the
    reason, instead of at migrate (TS ``storagePolicyChangeErrors``)."""
    errors: list[str] = []
    for op in plan.operations:
        if op.type not in ("alter_table_modify_setting", "alter_table_reset_setting"):
            continue
        if not op.key.endswith(":setting:storage_policy"):
            continue
        table = op.key.removeprefix("table:").removesuffix(":setting:storage_policy")
        errors.append(
            f"obsessiondb: {table} cannot change storage_policy: ObsessionDB stores every "
            "Shared table with storage_policy = 's3' and rejects any other. Keep "
            f'storage_policy: "{_OBSESSIONDB_STORAGE_POLICY}" in the schema, or leave it out.'
        )
    return errors


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
