"""Filesystem layout for migrations and snapshots.

We mirror the TypeScript chkit on-disk layout exactly:

- ``migrations/*.sql``  -- single source of truth, one file per migration.
- ``meta/snapshot.json`` -- canonicalized schema definitions from the last
  ``chkit generate``. Trailing newline matches the TS output.

The migration journal is kept in ClickHouse (table ``_chkit_migrations``)
when an executor is available, mirroring the TS reference. ``read_applied`` /
``write_applied`` provide the offline fallback used by tests and by environments
that have not yet pointed at a live ClickHouse instance.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict

from chkit.cli.snapshot_document import (
    ReadableSnapshotDocument,
    SnapshotUnreadableReason,
    parse_snapshot_document,
)
from chkit.core.model import MigrationPlan, SchemaDefinition, Snapshot

_MIGRATION_FORMAT_VERSION: Final[str] = "v1"
_EMPTY_PLAN: Final[MigrationPlan] = MigrationPlan.model_validate(
    {
        "operations": [],
        "renameSuggestions": [],
        "riskSummary": {"safe": 0, "caution": 0, "danger": 0},
    }
)
_SAFE_NAME_PATTERN: Final[re.Pattern[str]] = re.compile(r"[^a-zA-Z0-9_-]")
_SAFE_ID_PATTERN: Final[re.Pattern[str]] = re.compile(r"[^a-zA-Z0-9_-]")


class MigrationArtifact(BaseModel):
    """Return value of :func:`write_migration`.

    No sidecar files are written: ``sql_path`` is the only filesystem artifact
    produced. ``checksum`` is the sha256 of the SQL content for callers that
    want to record it (e.g. into the applied journal).
    """

    model_config = ConfigDict(frozen=True)

    id: str
    sql_path: Path
    checksum: str


class MigrationJournalEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    applied_at: str
    checksum: str


class MigrationJournal(BaseModel):
    model_config = ConfigDict(frozen=True)

    version: int = 1
    applied: list[MigrationJournalEntry] = []


class ChecksumMismatch(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    expected: str
    actual: str


def _now_iso() -> str:
    return datetime.now(tz=UTC).isoformat().replace("+00:00", "Z")


def _timestamp_id(now: datetime | None = None) -> str:
    """ISO timestamp stripped of separators, sliced to 14 chars.

    Mirrors the TypeScript ``new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14)``.
    """
    moment = now if now is not None else datetime.now(tz=UTC)
    iso = moment.isoformat()
    cleaned = "".join(ch for ch in iso if ch not in "-:TZ.+")
    return cleaned[:14]


def safe_name(name: str) -> str:
    """Sanitize a migration name. Mirrors the TS ``safeName`` helper."""
    return _SAFE_NAME_PATTERN.sub("_", name).lower()


def safe_migration_id(value: str) -> str:
    """Strip illegal characters from a custom migration id (TS ``safeMigrationId``)."""
    return _SAFE_ID_PATTERN.sub("", value)


def checksum_sql(sql_text: str) -> str:
    return hashlib.sha256(sql_text.encode("utf-8")).hexdigest()


def serialize_snapshot(snapshot: Snapshot) -> str:
    """Render a snapshot exactly as ``chkit generate`` writes it: 2-space JSON
    plus a trailing newline (TS ``serializeSnapshot``)."""
    # exclude_none matches TS JSON.stringify, which omits undefined keys.
    # Key *presence* is load-bearing for cross-implementation snapshots: TS
    # classifies projections via `'index' in projection`, so a serialized
    # `"index": null` would flip every SELECT projection to index-only there.
    payload = snapshot.model_dump(mode="json", by_alias=True, exclude_none=True)
    return json.dumps(payload, indent=2) + "\n"


def write_snapshot(meta_dir: Path, snapshot: Snapshot) -> Path:
    """Write ``<meta_dir>/snapshot.json``. Shared by ``chkit generate`` and
    ``chkit snapshot rebuild``, so both write byte-identical files (apart from
    ``generatedAt``)."""
    meta_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path = meta_dir / "snapshot.json"
    snapshot_path.write_text(serialize_snapshot(snapshot), encoding="utf-8")
    return snapshot_path


class SnapshotReadError(RuntimeError):
    """Raised when ``snapshot.json`` exists but cannot be read as JSON."""


def read_snapshot(meta_dir: Path) -> Snapshot | None:
    snapshot_path = meta_dir / "snapshot.json"
    if not snapshot_path.exists():
        return None
    parsed = parse_snapshot_document(snapshot_path.read_text(encoding="utf-8"))
    if isinstance(parsed, ReadableSnapshotDocument):
        return parsed.snapshot
    raise SnapshotReadError(_describe_unreadable_snapshot(snapshot_path, parsed.reason))


def _describe_unreadable_snapshot(file: Path, reason: SnapshotUnreadableReason) -> str:
    if reason == "conflict_markers":
        return (
            f"Snapshot {file} contains unresolved merge conflict markers. "
            "Resolve any conflicts in your schema files, then run `chkit snapshot rebuild` "
            "to rewrite snapshot.json from them, and review its report before committing. "
            "See https://chkit.obsessiondb.com/cli/snapshot/"
        )
    detail = " (the file is empty)" if reason == "empty" else ""
    # During a merge or rebase the committed version is only one side of the conflict.
    return (
        f"Invalid snapshot JSON at {file}{detail}. "
        "Outside a merge or rebase, restore the committed version from git. "
        "Otherwise, or if the file was never committed, run `chkit snapshot rebuild` "
        "to rewrite it from your schema definitions."
    )


def _build_migration_header(
    *,
    generated_at: str,
    cli_version: str,
    definition_count: int,
    plan: MigrationPlan,
) -> list[str]:
    return [
        f"-- chkit-migration-format: {_MIGRATION_FORMAT_VERSION}",
        f"-- generated-at: {generated_at}",
        f"-- cli-version: {cli_version}",
        f"-- definition-count: {definition_count}",
        f"-- operation-count: {len(plan.operations)}",
        f"-- rename-suggestion-count: {len(plan.rename_suggestions)}",
        (
            f"-- risk-summary: safe={plan.risk_summary.safe}, "
            f"caution={plan.risk_summary.caution}, "
            f"danger={plan.risk_summary.danger}"
        ),
    ]


def _build_migration_content(
    *,
    generated_at: str,
    cli_version: str,
    definition_count: int,
    plan: MigrationPlan,
) -> str:
    """Render the TS ``buildMigrationContent`` SQL artifact verbatim."""
    header = _build_migration_header(
        generated_at=generated_at,
        cli_version=cli_version,
        definition_count=definition_count,
        plan=plan,
    )
    rename_hints = [
        (
            f"-- rename-suggestion: kind={s.kind} "
            f"table={s.database}.{s.table} from={s.from_} to={s.to} "
            f"confidence={s.confidence}"
        )
        for s in plan.rename_suggestions
    ]
    body_blocks = [
        f"-- operation: {op.type} key={op.key} risk={op.risk}\n"
        + ("-- Warning: " + " ".join(op.warning.splitlines()) + "\n" if op.warning else "")
        + op.sql
        for op in plan.operations
    ]
    body = "\n\n".join(body_blocks)
    with_hints = [*header, *rename_hints]
    if not body:
        return "\n".join(with_hints) + "\n"
    return "\n".join(with_hints) + "\n\n" + body + "\n"


def _migration_filename(
    migrations_dir: Path, timestamp: str, name: str, collision_index: int
) -> Path:
    suffix = "" if collision_index == 0 else f"_{collision_index:03d}"
    return migrations_dir / f"{timestamp}_{name}{suffix}.sql"


def write_migration(
    migrations_dir: Path,
    meta_dir: Path,
    definitions: list[SchemaDefinition],
    plan: MigrationPlan,
    *,
    migration_name: str | None = None,
    migration_id: str | None = None,
    cli_version: str,
    now: datetime | None = None,
) -> MigrationArtifact | None:
    """Write a migration SQL file matching the TS ``generateArtifacts`` format.

    Returns ``None`` if the plan has no operations (no file is written, the
    snapshot still gets refreshed by the caller).

    Collision handling matches TS: if a file at the computed path already
    exists, a ``_NNN`` suffix is appended.
    """
    migrations_dir.mkdir(parents=True, exist_ok=True)
    meta_dir.mkdir(parents=True, exist_ok=True)

    if not plan.operations:
        return None

    moment = now if now is not None else datetime.now(tz=UTC)
    generated_at = moment.isoformat().replace("+00:00", "Z")
    auto_timestamp = _timestamp_id(moment)
    timestamp = (
        safe_migration_id(migration_id) if migration_id else ""
    ) or auto_timestamp
    name = safe_name(migration_name) if migration_name else "auto"

    sql_text = _build_migration_content(
        generated_at=generated_at,
        cli_version=cli_version,
        definition_count=len(definitions),
        plan=plan,
    )

    sql_path = _write_new_migration_file(migrations_dir, timestamp, name, sql_text)

    return MigrationArtifact(
        id=sql_path.stem,
        sql_path=sql_path,
        checksum=checksum_sql(sql_text),
    )


def generate_empty_migration(
    migrations_dir: Path,
    *,
    migration_name: str | None = None,
    migration_id: str | None = None,
    cli_version: str,
    now: datetime | None = None,
) -> MigrationArtifact:
    """Scaffold a blank manual migration file (TS ``generateEmptyMigration``).

    Unlike :func:`write_migration` this performs no schema diff and never
    touches the snapshot — it just writes a timestamped ``.sql`` stub for the
    user to hand-edit.
    """
    migrations_dir.mkdir(parents=True, exist_ok=True)
    moment = now if now is not None else datetime.now(tz=UTC)
    timestamp = (
        safe_migration_id(migration_id) if migration_id else ""
    ) or _timestamp_id(moment)
    name = safe_name(migration_name if migration_name is not None else "manual")
    header = _build_migration_header(
        generated_at=moment.isoformat().replace("+00:00", "Z"),
        cli_version=cli_version,
        definition_count=0,
        plan=_EMPTY_PLAN,
    )
    placeholder = [
        "-- Empty migration scaffold. Write your SQL statements below.",
        "-- Statements run in order and are separated by semicolons.",
    ]
    sql_text = "\n".join(header) + "\n\n" + "\n".join(placeholder) + "\n"
    sql_path = _write_new_migration_file(migrations_dir, timestamp, name, sql_text)
    return MigrationArtifact(id=sql_path.stem, sql_path=sql_path, checksum=checksum_sql(sql_text))


def _write_new_migration_file(
    migrations_dir: Path, timestamp: str, name: str, sql_text: str
) -> Path:
    """Write ``sql_text`` to a fresh file, adding a ``_NNN`` suffix on collision."""
    collision = 0
    while True:
        candidate = _migration_filename(migrations_dir, timestamp, name, collision)
        try:
            with candidate.open("x", encoding="utf-8") as handle:
                handle.write(sql_text)
        except FileExistsError:
            collision += 1
            continue
        return candidate


def list_migrations(migrations_dir: Path) -> list[Path]:
    if not migrations_dir.exists():
        return []
    return sorted(migrations_dir.glob("*.sql"))


def list_migration_filenames(migrations_dir: Path) -> list[str]:
    """Return migration filenames (with ``.sql``) — matches TS ``listMigrations``."""
    return [p.name for p in list_migrations(migrations_dir)]


def read_applied(meta_dir: Path) -> set[str]:
    """Local fallback when no ClickHouse executor is available.

    Returns the set of migration filenames (with ``.sql``) marked applied in
    ``meta/applied.json``. The TS code path stores the journal in a
    ClickHouse table; this file is an offline-mode shim.
    """
    applied_file = meta_dir / "applied.json"
    if not applied_file.exists():
        return set()
    payload = json.loads(applied_file.read_text(encoding="utf-8"))
    return {str(item) for item in payload.get("ids", [])}


def write_applied(meta_dir: Path, ids: set[str]) -> None:
    meta_dir.mkdir(parents=True, exist_ok=True)
    applied_file = meta_dir / "applied.json"
    applied_file.write_text(
        json.dumps({"ids": sorted(ids)}, indent=2), encoding="utf-8"
    )


def pending_migrations(migrations_dir: Path, meta_dir: Path) -> list[str]:
    """Return filenames of every migration on disk that has not been applied yet."""
    applied = read_applied(meta_dir)
    return [m.name for m in list_migrations(migrations_dir) if m.name not in applied]


def find_checksum_mismatches(
    migrations_dir: Path, journal: MigrationJournal
) -> list[ChecksumMismatch]:
    """Compare current SQL files vs journal-recorded checksums."""
    mismatches: list[ChecksumMismatch] = []
    for entry in journal.applied:
        if not entry.checksum:
            continue
        path = migrations_dir / entry.name
        if not path.exists():
            continue
        actual = checksum_sql(path.read_text(encoding="utf-8"))
        if actual != entry.checksum:
            mismatches.append(
                ChecksumMismatch(
                    name=entry.name,
                    expected=entry.checksum,
                    actual=actual,
                )
            )
    return mismatches


def applied_from_local_journal(meta_dir: Path) -> MigrationJournal:
    """Construct a MigrationJournal from the local ``applied.json``.

    The local fallback doesn't preserve checksums (it only stores filenames),
    so the entries carry empty checksum and ``applied_at`` strings.
    """
    return MigrationJournal(
        applied=[
            MigrationJournalEntry(name=name, applied_at="", checksum="")
            for name in sorted(read_applied(meta_dir))
        ]
    )


def now_iso() -> str:
    return _now_iso()
