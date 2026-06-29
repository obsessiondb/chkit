"""Plan/run state persistence (XDG-aware, atomic-ish writes).

1:1 port of ``packages/plugin-backfill/src/state.ts``. Phase 1 leaves the
chunking-plan decoding as a pass-through (returns the raw dict); Phase 2 will
plug in a typed decoder once the chunking module is ported.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from chkit.core import ChxResolvedConfig
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.types import (
    BackfillEnvironment,
    BackfillPathSet,
    BackfillPlanState,
    BackfillPlanStatus,
    BackfillRunState,
    BackfillStatusSummary,
    BackfillStatusTotals,
)


def hash_id(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def now_iso() -> str:
    utc = datetime.now(tz=UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def random_plan_id() -> str:
    return secrets.token_hex(8)


def compute_environment_fingerprint(
    clickhouse: dict[str, str] | None,
) -> BackfillEnvironment | None:
    if not clickhouse:
        return None
    url = clickhouse.get("url")
    if not url:
        return None
    database = clickhouse.get("database") or "default"
    split = urlsplit(url)
    if not split.scheme or not split.netloc:
        return None
    origin = f"{split.scheme}://{split.netloc}"
    fingerprint = hash_id(f"{origin}|{database}")[:16]
    return BackfillEnvironment(
        fingerprint=fingerprint, url=origin, database=database
    )


def ensure_environment_match(
    *,
    plan: BackfillPlanState,
    clickhouse: dict[str, str] | None,
    force_environment: bool,
) -> None:
    if plan.environment is None or clickhouse is None:
        return
    current = compute_environment_fingerprint(clickhouse)
    if current is None or current.fingerprint == plan.environment.fingerprint:
        return
    if force_environment:
        return
    msg = (
        f"Environment mismatch for plan {plan.plan_id}. "
        f"Plan was created for {plan.environment.url} "
        f"(database: {plan.environment.database}), "
        f"but current config points to {current.url} "
        f"(database: {current.database}). "
        "Retry with --force-environment to override."
    )
    raise BackfillConfigError(msg)


def compute_backfill_state_dir(
    config: ChxResolvedConfig,
    config_path: str | Path,
    state_dir: str | None = None,
) -> Path:
    config_dir = Path(config_path).resolve().parent
    if state_dir:
        return (config_dir / state_dir).resolve()
    return (config_dir / config.meta_dir / "backfill").resolve()


def backfill_paths(state_dir: Path | str, plan_id: str) -> BackfillPathSet:
    base = Path(state_dir)
    plans_dir = base / "plans"
    runs_dir = base / "runs"
    return BackfillPathSet(
        state_dir=str(base),
        plans_dir=str(plans_dir),
        runs_dir=str(runs_dir),
        plan_path=str(plans_dir / f"{plan_id}.json"),
        run_path=str(runs_dir / f"{plan_id}.json"),
    )


def write_json(file_path: str | Path, value: object) -> None:
    path = Path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, default=_json_default) + "\n"
    path.write_text(payload, encoding="utf-8")


def _json_default(value: object) -> object:
    if hasattr(value, "model_dump"):
        dumped: object = value.model_dump(by_alias=True, exclude_none=True)
        return dumped
    msg = f"Object of type {type(value).__name__} is not JSON serializable"
    raise TypeError(msg)


def _read_json_maybe(file_path: Path) -> dict[str, object] | None:
    if not file_path.exists():
        return None
    raw = file_path.read_text(encoding="utf-8")
    loaded = json.loads(raw)
    if not isinstance(loaded, dict):
        return None
    return loaded


def read_plan(
    *,
    plan_id: str,
    config_path: str | Path,
    config: ChxResolvedConfig,
    state_dir: str | None = None,
) -> tuple[BackfillPlanState, str, Path]:
    """Return ``(plan, plan_path, state_dir)`` for the given plan id.

    Raises ``BackfillConfigError`` if the file is missing or uses an obsolete
    layout (no ``chunkPlan`` field).
    """
    base_state_dir = compute_backfill_state_dir(config, config_path, state_dir)
    paths = backfill_paths(base_state_dir, plan_id)
    raw = _read_json_maybe(Path(paths.plan_path))
    if raw is None:
        msg = f"Backfill plan not found: {paths.plan_path}"
        raise BackfillConfigError(msg)
    if "chunkPlan" not in raw and "chunk_plan" not in raw:
        msg = (
            f"Backfill plan {plan_id} uses a previous chunking format and "
            "can no longer be loaded. Recreate the plan."
        )
        raise BackfillConfigError(msg)
    plan = BackfillPlanState.model_validate(raw)
    return plan, paths.plan_path, base_state_dir


def read_run(run_path: str | Path) -> BackfillRunState | None:
    raw = _read_json_maybe(Path(run_path))
    if raw is None:
        return None
    return BackfillRunState.model_validate(raw)


def list_plan_ids(plans_dir: str | Path) -> list[str]:
    path = Path(plans_dir)
    if not path.exists():
        return []
    return sorted(
        entry.stem
        for entry in path.iterdir()
        if entry.is_file() and entry.suffix == ".json"
    )


def summarize_run_status(
    run: BackfillRunState,
    run_path: str | Path,
    plan: BackfillPlanState,
) -> BackfillStatusSummary:
    chunks = _chunks_from_plan(plan.chunk_plan)
    totals = BackfillStatusTotals.model_construct(
        total=len(chunks), pending=0, submitted=0, running=0, done=0, failed=0
    )
    counters: dict[str, int] = {
        "pending": 0,
        "submitted": 0,
        "running": 0,
        "done": 0,
        "failed": 0,
    }
    rows_written = 0
    for chunk_id in chunks:
        state = run.progress.get(chunk_id)
        if state is None:
            counters["pending"] += 1
            continue
        rows_written += state.written_rows or 0
        counters[state.status] += 1
    return BackfillStatusSummary(
        plan_id=run.plan_id,
        target=run.target,
        status=plan_status_for(run, totals.total, counters),
        totals=BackfillStatusTotals(total=len(chunks), **counters),
        rows_written=rows_written,
        updated_at=run.updated_at,
        run_path=str(run_path),
        last_error=run.last_error,
    )


def _chunks_from_plan(chunk_plan: dict[str, object]) -> list[str]:
    """Return the chunk ids in plan-order, defaulting to ``[]`` if absent.

    Phase 1 keeps ``chunk_plan`` as an opaque dict; this helper only inspects
    the parts needed for status summaries (the ``chunks`` array and per-chunk
    ``id``). Robust to either camelCase or snake_case storage shapes.
    """
    raw_chunks = chunk_plan.get("chunks")
    if not isinstance(raw_chunks, list):
        return []
    ids: list[str] = []
    for entry in raw_chunks:
        if isinstance(entry, dict):
            cid = entry.get("id")
            if isinstance(cid, str):
                ids.append(cid)
    return ids


def plan_status_for(
    run: BackfillRunState,
    total_chunks: int,
    counters: dict[str, int],
) -> BackfillPlanStatus:
    """Return the canonical plan-level status for a ``run``.

    1:1 with TS ``summarizeRunStatus``: always return the run's persisted
    status. Chunk-based status derivation lives in the engine that updates
    ``run.status`` before persisting — we no longer override it here.
    """
    _ = total_chunks
    _ = counters
    return run.status


def chunk_ids_in_order(plan: BackfillPlanState) -> Iterable[str]:
    """Re-export of the internal helper for callers that need plan walk order."""
    yield from _chunks_from_plan(plan.chunk_plan)


__all__ = [
    "BackfillPathSet",
    "backfill_paths",
    "chunk_ids_in_order",
    "compute_backfill_state_dir",
    "compute_environment_fingerprint",
    "ensure_environment_match",
    "hash_id",
    "list_plan_ids",
    "now_iso",
    "plan_status_for",
    "random_plan_id",
    "read_plan",
    "read_run",
    "summarize_run_status",
    "write_json",
]
