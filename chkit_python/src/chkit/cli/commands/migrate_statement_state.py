"""What the journal record of one migration statement says.

1:1 port of ``packages/cli/src/commands/migrate/statement-state.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from chkit.cli.journal_store import OperationState, OperationStatus

# ``last_error`` of a completed sync statement whose DDL propagation wait has
# not passed yet (#513). A statement is recorded completed before its wait, so a
# re-run never replays it; while this marker is set, a re-run waits for it
# again before it runs the next statement. A write after the wait passes clears
# it. --abandon replaces it, and --retry keeps it with the record.
PROPAGATION_WAIT_PENDING = "executed; waiting for the change to reach every replica"

_OPERATION_STATUSES: tuple[OperationStatus, ...] = ("completed", "failed", "started")


@dataclass(frozen=True, slots=True)
class Completed:
    state: Literal["completed"] = "completed"


@dataclass(frozen=True, slots=True)
class AwaitingReplicas:
    """It ran; the next apply waits again for every replica before the next statement."""

    state: Literal["awaiting_replicas"] = "awaiting_replicas"


@dataclass(frozen=True, slots=True)
class Interrupted:
    """chkit stopped while this sync statement ran, so it may have run."""

    state: Literal["interrupted"] = "interrupted"


@dataclass(frozen=True, slots=True)
class Running:
    """An async statement whose query may still run on the server."""

    query_id: str
    state: Literal["running"] = "running"


@dataclass(frozen=True, slots=True)
class Failed:
    error: str
    state: Literal["failed"] = "failed"


@dataclass(frozen=True, slots=True)
class Abandoned:
    """--abandon marked it failed; ``was`` is its status before."""

    was: OperationStatus
    state: Literal["abandoned"] = "abandoned"


StatementState = Completed | AwaitingReplicas | Interrupted | Running | Failed | Abandoned


def statement_state(op: OperationState) -> StatementState:
    """Decode a record's status, query id and ``last_error``; the record keeps its stored shape."""
    if op.status == "completed":
        return AwaitingReplicas() if op.last_error == PROPAGATION_WAIT_PENDING else Completed()
    if op.status == "started":
        return Interrupted() if op.query_id == "" else Running(op.query_id)
    was = next((s for s in _OPERATION_STATUSES if op.last_error == abandoned_error(s)), None)
    return Failed(op.last_error) if was is None else Abandoned(was)


def abandoned_error(previous: OperationStatus) -> str:
    """The ``last_error`` --abandon records for a statement whose status was ``previous``."""
    return f"abandoned via chkit migrate --abandon (was {previous})"
