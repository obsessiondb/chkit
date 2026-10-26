"""``generate --cutover``: replace a structural DROP + CREATE with a zero-downtime cutover.

Port of ``packages/cli/src/commands/generate/cutover.ts``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import cast

from chkit.core.cutover import (
    CUTOVER_COPY_MODES,
    CUTOVER_OLD_TABLE_MODES,
    CutoverCopyMode,
    CutoverOldTableMode,
    CutoverOptions,
    CutoverRequest,
    PlannedCutover,
    parse_cutover_request,
    plan_cutover,
    reads_table,
)
from chkit.core.model import (
    MaterializedViewDefinition,
    MigrationOperation,
    MigrationPlan,
    SchemaDefinition,
    TableDefinition,
    ViewDefinition,
)

_KIND_PREFIX = re.compile(r"^\w+:")


@dataclass(frozen=True)
class ResolvedCutovers:
    requests: list[CutoverRequest]
    copy: CutoverCopyMode
    old_table: CutoverOldTableMode


def resolve_cutover_flags(
    *,
    cutover: list[str],
    copy: str | None,
    old_table: str | None,
) -> ResolvedCutovers:
    """Reads ``--cutover``, ``--cutover-copy`` and ``--cutover-old``; usage errors raise."""
    requests = [parse_cutover_request(value) for value in cutover]
    if not requests and (copy is not None or old_table is not None):
        msg = (
            "--cutover-copy and --cutover-old apply to a cutover: "
            "add --cutover <database>.<table>=<key columns>."
        )
        raise ValueError(msg)
    seen: set[str] = set()
    for request in requests:
        target = f"{request.database}.{request.table}"
        if target in seen:
            msg = f"--cutover {target} is given more than once."
            raise ValueError(msg)
        seen.add(target)
    copy_mode = copy if copy is not None else "migration"
    if copy_mode not in CUTOVER_COPY_MODES:
        msg = f'Invalid --cutover-copy "{copy_mode}". Expected {" or ".join(CUTOVER_COPY_MODES)}.'
        raise ValueError(msg)
    old_mode = old_table if old_table is not None else "keep"
    if old_mode not in CUTOVER_OLD_TABLE_MODES:
        msg = (
            f'Invalid --cutover-old "{old_mode}". '
            f"Expected {' or '.join(CUTOVER_OLD_TABLE_MODES)}."
        )
        raise ValueError(msg)
    return ResolvedCutovers(
        requests=requests,
        copy=copy_mode,
        old_table=old_mode,
    )


def carry_retained_definitions(
    *,
    previous_definitions: list[SchemaDefinition],
    definitions: list[SchemaDefinition],
    drop_retained: list[str],
) -> list[SchemaDefinition]:
    """Tables a keep-mode cutover retained stay planned as they are.

    ``--drop-retained`` leaves one out, which plans its DROP like any removed
    table. A table the schema declares again is planned from the schema.
    """
    retained = [
        definition
        for definition in previous_definitions
        if isinstance(definition, TableDefinition) and definition.retained_by is not None
    ]
    retained_names = [f"{d.database}.{d.name}" for d in retained]
    for name in drop_retained:
        if name not in retained_names:
            known = f" (retained: {', '.join(retained_names)})" if retained_names else ""
            msg = f"--drop-retained {name}: no table retained by a cutover has that name{known}."
            raise ValueError(msg)
    drop = set(drop_retained)
    declared = {f"{d.kind}:{d.database}.{d.name}" for d in definitions}
    carried: list[SchemaDefinition] = [
        d
        for d in retained
        if f"{d.database}.{d.name}" not in drop and f"table:{d.database}.{d.name}" not in declared
    ]
    return [*definitions, *carried]


def apply_cutovers(
    *,
    plan: MigrationPlan,
    previous_definitions: list[SchemaDefinition],
    definitions: list[SchemaDefinition],
    cutovers: ResolvedCutovers,
    cluster: str | None,
    stamp: str,
) -> tuple[MigrationPlan, list[PlannedCutover]]:
    """Replace the DROP + CREATE that ``plan_diff`` emits for each cutover table
    with the cutover's operations, at the CREATE's position."""
    operations = list(plan.operations)
    planned: list[PlannedCutover] = []
    for request in cutovers.requests:
        target = f"{request.database}.{request.table}"
        key = f"table:{target}"
        drop_index = next(
            (i for i, op in enumerate(operations) if op.type == "drop_table" and op.key == key),
            -1,
        )
        create_index = next(
            (i for i, op in enumerate(operations) if op.type == "create_table" and op.key == key),
            -1,
        )
        if drop_index == -1 or create_index == -1:
            empty = "; the plan is empty" if not plan.operations else ""
            msg = (
                f"--cutover {target}: the plan does not recreate {target}. A cutover replaces "
                "the DROP TABLE and CREATE TABLE of a change to the engine, ORDER BY, PRIMARY "
                f"KEY or PARTITION BY of an existing table{empty}. Check the table name and "
                "the --table scope."
            )
            raise ValueError(msg)
        _assert_no_dependent_recreated(
            operations, [*previous_definitions, *definitions], request
        )
        old_def = _find_table(previous_definitions, request)
        new_def = _find_table(definitions, request)
        if old_def is None or new_def is None:
            msg = f"--cutover {target}: the table is missing from the snapshot or the schema."
            raise ValueError(msg)
        cutover = plan_cutover(
            old_def=old_def,
            new_def=new_def,
            request=request,
            options=CutoverOptions(
                copy=cutovers.copy,
                old_table=cutovers.old_table,
                cluster=cluster,
                stamp=stamp,
            ),
            definitions=definitions,
        )
        planned.append(cutover)
        drop, create = operations[drop_index], operations[create_index]
        rebuilt: list[MigrationOperation] = []
        for op in operations:
            if op is create:
                rebuilt.extend(cutover.operations)
            elif op is not drop:
                rebuilt.append(op)
        operations = rebuilt
    summary = {"safe": 0, "caution": 0, "danger": 0}
    for op in operations:
        summary[op.risk] += 1
    return (
        plan.model_copy(
            update={
                "operations": operations,
                "risk_summary": plan.risk_summary.model_copy(update=summary),
            }
        ),
        planned,
    )


def summarize_cutover(cutover: PlannedCutover) -> dict[str, object]:
    """What ``generate`` reports for each cutover, in JSON and text (TS ``CutoverSummary``)."""
    request, options, names = cutover.request, cutover.options, cutover.names
    target = f"{request.database}.{request.table}"
    next_steps = (
        [
            "chkit migrate --apply  (creates the shadow table and the mirror, then stops at "
            "the copy check)",
            f"chkit plugin backfill plan --cutover {target}  (then run or submit the plan)",
            "chkit migrate --apply  (verifies the copy and swaps the tables)",
        ]
        if options.copy == "backfill"
        else ["chkit migrate --apply"]
    )
    summary: dict[str, object] = {
        "table": target,
        "key": list(request.key),
        "copy": options.copy,
        "oldTable": options.old_table,
        "shadow": f"{request.database}.{names.shadow}",
        "mirror": f"{request.database}.{names.mirror}",
        "snapshot": f"{request.database}.{names.snapshot}",
        "columns": list(cutover.columns),
    }
    if cutover.retained is not None:
        summary["retainedAs"] = f"{request.database}.{names.previous}"
    summary["nextSteps"] = next_steps
    return summary


def cutover_text_lines(summaries: list[dict[str, object]]) -> list[str]:
    """Human output for each cutover (TS ``printCutovers``)."""
    lines: list[str] = []
    for summary in summaries:
        key = ", ".join(cast("list[str]", summary["key"]))
        lines.append("")
        lines.append(
            f"Cutover {summary['table']} (key {key}, copy: {summary['copy']}, "
            f"old table: {summary['oldTable']})"
        )
        lines.append(
            f"  shadow {summary['shadow']}, mirror {summary['mirror']}, "
            f"snapshot {summary['snapshot']}"
        )
        if "retainedAs" in summary:
            lines.append(f"  the old table is kept as {summary['retainedAs']}")
        lines.append("  Next:")
        lines.extend(f"  - {step}" for step in cast("list[str]", summary["nextSteps"]))
    return lines


def _assert_no_dependent_recreated(
    operations: list[MigrationOperation],
    definitions: list[SchemaDefinition],
    request: CutoverRequest,
) -> None:
    """A view that reads from or writes into the cutover table and is dropped and
    recreated by the same migration would miss every INSERT of the cutover: the
    drop runs before the cutover's first step and the CREATE after its last."""
    target = f"{request.database}.{request.table}"
    table = (request.database, request.table)
    dependents: set[str] = set()
    for definition in definitions:
        if isinstance(definition, MaterializedViewDefinition):
            writes = (
                definition.to.database == request.database
                and definition.to.name == request.table
            )
            if writes or reads_table(definition.as_, table, definition.database):
                dependents.add(f"materialized_view:{definition.database}.{definition.name}")
        elif isinstance(definition, ViewDefinition) and reads_table(
            definition.as_, table, definition.database
        ):
            dependents.add(f"view:{definition.database}.{definition.name}")
    recreated = next(
        (
            op
            for op in operations
            if op.type in ("drop_materialized_view", "drop_view") and op.key in dependents
        ),
        None,
    )
    if recreated is not None:
        msg = (
            f"--cutover {target}: {_KIND_PREFIX.sub('', recreated.key, count=1)} reads from or "
            f"writes into {target} and is recreated in the same migration, so it would miss "
            "every INSERT during the cutover. Change it in a separate migration, before or "
            "after the cutover."
        )
        raise ValueError(msg)


def _find_table(
    definitions: list[SchemaDefinition], request: CutoverRequest
) -> TableDefinition | None:
    for definition in definitions:
        if (
            isinstance(definition, TableDefinition)
            and definition.database == request.database
            and definition.name == request.table
        ):
            return definition
    return None
