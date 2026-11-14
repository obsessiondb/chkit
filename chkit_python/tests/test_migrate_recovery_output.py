"""Recovery acknowledgement precedes success JSON, including an empty apply."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from chkit.cli.commands import migrate
from chkit.cli.table_scope import resolve_table_scope


@pytest.mark.parametrize("no_scope_match", [False, True])
def test_no_pending_recovery_failure_emits_no_success_json(
    no_scope_match: bool, monkeypatch: pytest.MonkeyPatch,
) -> None:
    output: list[tuple[Any, ...]] = []
    monkeypatch.setattr(migrate, "emit_json", lambda *args: output.append(args))

    def fail() -> None:
        raise RuntimeError("journal proof failed")

    context: Any = SimpleNamespace(complete_recovery=fail)
    plan: Any = SimpleNamespace(no_scope_match=no_scope_match)
    with pytest.raises(RuntimeError, match="journal proof failed"):
        migrate._render_nothing_pending(context, plan)
    assert output == []


def test_apply_summary_follows_recovery_ack(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[str] = []
    monkeypatch.setattr(migrate, "emit_json", lambda *_args: events.append("success JSON"))
    context: Any = SimpleNamespace(
        json_mode=True, complete_recovery=lambda: events.append("recovery ACK"),
        table_scope=resolve_table_scope(None, []),
    )
    plan: Any = SimpleNamespace(retry=None, pending=[], undetermined=[])
    migrate._apply_plan(context, plan)
    assert events == ["recovery ACK", "success JSON"]
