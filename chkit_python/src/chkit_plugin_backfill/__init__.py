"""chkit_plugin_backfill — local backfill orchestration for chkit-py (Phase 1).

Python port of ``packages/plugin-backfill`` (Phase 1 surface).

**What ships in Phase 1**:

- ``backfill()`` plugin factory + ``ChxPlugin`` skeleton with two
  command stubs (``status``, ``cancel``) wired to local plan/run state.
- ``options.py`` — Pydantic-validated plugin/CLI option models for the
  six commands (plan / run / resume / status / cancel / doctor).
- ``state.py`` — XDG-aware plan/run state files (``backfillPaths``,
  ``readPlan``, ``readRun``, ``writeJson``, environment fingerprinting,
  ``summarizeRunStatus``).
- ``types.py`` — Pydantic models for ``BackfillPlanState`` /
  ``BackfillRunState`` / ``BackfillStatusSummary`` (and the structural
  envelopes the future planner + executor will use).
- ``errors.py`` — ``BackfillConfigError``.

**What is intentionally DEFERRED to Phase 2** (see ``DRIFT.md`` →
"plugin-backfill" entry for the full rationale):

- The chunking engine (``chunking/planner.ts``, 546 LoC pure algorithm
  + ``partition-slices.ts`` + ``boundary-codec.ts`` + ``sql.ts`` + the
  strategies directory) — ~1,400 LoC of size-aware time-window splitting.
- The async-backfill execution engine (``async-backfill.ts``, 364 LoC
  of bounded-concurrency + poll-by-query_id + checkpoint persistence).
- The `plan` / `run` / `resume` / `doctor` command runners (depend on
  the above two).
- ``on_check`` hook (depends on the planner to detect pending backfills).

The remote-backfill routing (``chkit plugin backfill status --job-id …``
against a managed ObsessionDB instance) already works via
``chkit_plugin_obsessiondb.backfill_handler`` (Phase 4 of obsessiondb).
"""

from __future__ import annotations

from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.options import (
    PLAN_FLAG_MAP,
    PLAN_FLAGS,
    PLAN_ID_FLAG_MAP,
    PLAN_ID_FLAGS,
    RESUME_FLAG_MAP,
    RESUME_FLAGS,
    RUN_FLAG_MAP,
    RUN_FLAGS,
    CheckOptions,
    PlanOptions,
    PluginConfig,
    ResumeOptions,
    RunOptions,
    StatusOptions,
    parse_byte_size,
)
from chkit_plugin_backfill.plugin import backfill, create_backfill_plugin
from chkit_plugin_backfill.state import (
    BackfillPathSet,
    backfill_paths,
    compute_backfill_state_dir,
    compute_environment_fingerprint,
    ensure_environment_match,
    hash_id,
    list_plan_ids,
    now_iso,
    random_plan_id,
    read_plan,
    read_run,
    summarize_run_status,
    write_json,
)
from chkit_plugin_backfill.types import (
    BackfillEnvironment,
    BackfillExecutionPlan,
    BackfillPlanState,
    BackfillRunState,
    BackfillStatusSummary,
)

__all__ = [
    "PLAN_FLAGS",
    "PLAN_FLAG_MAP",
    "PLAN_ID_FLAGS",
    "PLAN_ID_FLAG_MAP",
    "RESUME_FLAGS",
    "RESUME_FLAG_MAP",
    "RUN_FLAGS",
    "RUN_FLAG_MAP",
    "BackfillConfigError",
    "BackfillEnvironment",
    "BackfillExecutionPlan",
    "BackfillPathSet",
    "BackfillPlanState",
    "BackfillRunState",
    "BackfillStatusSummary",
    "CheckOptions",
    "PlanOptions",
    "PluginConfig",
    "ResumeOptions",
    "RunOptions",
    "StatusOptions",
    "backfill",
    "backfill_paths",
    "compute_backfill_state_dir",
    "compute_environment_fingerprint",
    "create_backfill_plugin",
    "ensure_environment_match",
    "hash_id",
    "list_plan_ids",
    "now_iso",
    "parse_byte_size",
    "random_plan_id",
    "read_plan",
    "read_run",
    "summarize_run_status",
    "write_json",
]
