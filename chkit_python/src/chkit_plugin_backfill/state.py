"""Plan/run state persistence (XDG-aware, atomic-ish writes).

1:1 port of ``packages/plugin-backfill/src/state.ts``. Plans persist their
string sort-key boundaries hex-encoded (see ``chunking/boundary_codec``);
``read_plan`` decodes them back after validation.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

from chkit_plugin_backfill.chunking.boundary_codec import (
    decode_chunk_plan_from_persistence,
)
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


_SCHEME_DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21}


def _url_origin(url: str) -> str:
    """WHATWG ``new URL(url).origin``: lowercase scheme+host, no userinfo,
    scheme-default ports dropped. Raises ``ValueError`` on an unparseable URL
    (TS ``new URL`` throws — the fingerprint must not be silently skipped)."""
    split = urlsplit(url)
    if not split.scheme or split.hostname is None:
        msg = f"Invalid URL: {url}"
        raise ValueError(msg)
    scheme = split.scheme.lower()
    host = split.hostname.lower()
    if ":" in host:  # IPv6 literal — restore brackets
        host = f"[{host}]"
    port = split.port
    if port is not None and _SCHEME_DEFAULT_PORTS.get(scheme) != port:
        return f"{scheme}://{host}:{port}"
    return f"{scheme}://{host}"


def compute_environment_fingerprint(
    clickhouse: dict[str, str] | None,
) -> BackfillEnvironment | None:
    if not clickhouse:
        return None
    url = clickhouse.get("url")
    if not url:
        return None
    database = clickhouse.get("database") or "default"
    origin = _url_origin(url)
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


class _HasMetaDir(Protocol):
    """Structural slice of ``ChxResolvedConfig`` the state layer needs."""

    @property
    def meta_dir(self) -> str: ...


def compute_backfill_state_dir(
    config: _HasMetaDir,
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
    payload = (
        json.dumps(_jsonable(value), indent=2, default=_json_default) + "\n"
    )
    # Write-then-replace so a crash mid-write never leaves a truncated
    # checkpoint (resume depends on run.json always being parseable).
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(payload, encoding="utf-8")
    os.replace(tmp_path, path)


_JS_INTEGER_PRINT_BOUND = 1e21


def _jsonable(value: object) -> object:
    """Normalize a value tree for TS-identical JSON.

    Pydantic dumps produce ``float`` for JS-number fields; ``json.dumps``
    would render ``4096.0`` where ``JSON.stringify`` renders ``4096``.
    Integral floats collapse to int (within JS's integer-print bound) so
    Python-written plan files byte-match TS-written ones.
    """
    if hasattr(value, "model_dump"):
        dumped: object = value.model_dump(by_alias=True, exclude_none=True)
        return _jsonable(dumped)
    if isinstance(value, dict):
        return {key: _jsonable(entry) for key, entry in value.items()}
    if isinstance(value, list):
        return [_jsonable(entry) for entry in value]
    if (
        isinstance(value, float)
        and value == int(value)
        and abs(value) < _JS_INTEGER_PRINT_BOUND
    ):
        return int(value)
    return value


def _json_default(value: object) -> object:
    if hasattr(value, "model_dump"):
        dumped: object = value.model_dump(by_alias=True, exclude_none=True)
        return _jsonable(dumped)
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
    config: _HasMetaDir,
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
    plan = plan.model_copy(
        update={"chunk_plan": decode_chunk_plan_from_persistence(plan.chunk_plan)}
    )
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
    chunks = [chunk.id for chunk in plan.chunk_plan.chunks]
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
    """Chunk ids in plan order (for callers that need plan walk order)."""
    for chunk in plan.chunk_plan.chunks:
        yield chunk.id


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
