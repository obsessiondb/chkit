"""JSON payload builders — port of ``packages/plugin-backfill/src/payload.ts``.

Payloads are plain dicts with camelCase keys so ``--json`` output matches the
TS CLI byte-for-byte (``None``-valued optional keys are omitted, mirroring
``JSON.stringify`` dropping ``undefined``).
"""

from __future__ import annotations

from typing import Any

from chkit_plugin_backfill.planner import BuildBackfillPlanOutput
from chkit_plugin_backfill.types import BackfillDoctorReport, BackfillStatusSummary


def plan_payload(output: BuildBackfillPlanOutput) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": True,
        "command": "plan",
        "planId": output.plan.plan_id,
        "target": output.plan.target,
        "from": output.plan.from_,
        "to": output.plan.to,
        "chunkCount": len(output.plan.chunk_plan.chunks),
    }
    # Optional keys sit in the TS literal's position; JSON.stringify drops
    # them when undefined, so omit-on-None keeps key order identical.
    if output.plan.options.max_chunk_bytes is not None:
        payload["maxChunkBytes"] = output.plan.options.max_chunk_bytes
    if output.plan.options.sort_key_column is not None:
        payload["sortKeyColumn"] = output.plan.options.sort_key_column
    payload["planPath"] = output.plan_path
    payload["strategy"] = output.plan.execution.mode
    payload["partitionCount"] = len(output.plan.chunk_plan.partitions)
    payload["totalBytes"] = output.plan.chunk_plan.total_bytes_compressed
    return payload


def status_payload(summary: BackfillStatusSummary) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": summary.status != "failed",
        "command": "status",
        "planId": summary.plan_id,
        "status": summary.status,
        "chunkCounts": summary.totals.model_dump(),
        "rowsWritten": summary.rows_written,
        "runPath": summary.run_path,
        "updatedAt": summary.updated_at,
    }
    if summary.last_error is not None:
        payload["lastError"] = summary.last_error
    return payload


def cancel_payload(summary: BackfillStatusSummary) -> dict[str, Any]:
    return {
        "ok": summary.status == "cancelled",
        "command": "cancel",
        "planId": summary.plan_id,
        "status": summary.status,
        "chunkCounts": summary.totals.model_dump(),
        "runPath": summary.run_path,
    }


def doctor_payload(report: BackfillDoctorReport) -> dict[str, Any]:
    return {
        "ok": len(report.issue_codes) == 0,
        "command": "doctor",
        "planId": report.plan_id,
        "status": report.status,
        "issueCodes": report.issue_codes,
        "recommendations": report.recommendations,
        "failedChunkIds": report.failed_chunk_ids,
    }


__all__ = ["cancel_payload", "doctor_payload", "plan_payload", "status_payload"]
