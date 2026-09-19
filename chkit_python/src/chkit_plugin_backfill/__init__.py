"""chkit_plugin_backfill — local backfill orchestration for chkit-py.

Full Python port of ``packages/plugin-backfill``:

- ``backfill()`` plugin factory with all seven commands (plan / submit /
  run / resume / status / cancel / doctor) and the ``on_check`` hook.
- ``chunking/`` — the chunk-plan engine (partition introspection, smart
  size-aware splitting strategies, boundary codec, execution SQL builder).
- ``async_backfill.py`` — bounded-concurrency submit + poll execution
  loop with checkpoint persistence and server-side reconciliation.
- ``planner.py`` / ``detect.py`` — ``build_backfill_plan`` orchestration
  and table-vs-mv_replay strategy detection.
- ``state.py`` / ``types.py`` — plan/run state files and models.

The managed-job path (``chkit plugin backfill submit`` against an
ObsessionDB service) lives in ``chkit_plugin_obsessiondb.backfill_submit``.
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
