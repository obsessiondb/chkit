"""``ON CLUSTER`` injection for the migration plan.

Mirrors the TypeScript ``@chkit/core/on-cluster.ts`` (commit ``6b87e6d`` on
``main``). Cluster mode is a self-managed multi-node setup: when
``clickhouse.cluster`` is set, every generated DDL statement in the migration
plan is stamped with ``ON CLUSTER '<name>'`` and the migration journal is
stored in a replicated engine. This module is the plan-level post-pass — the
journal-store rewrite lives in :mod:`chkit.cli.journal_store`.

The port is a byte-for-byte behavioral mirror of the TS module:

- Two anchor tables, checked in the same order (trailing anchors FIRST so
  ``RENAME TABLE`` places the clause at the end, not after the source name).
- Idempotency is checked **positionally** — at the exact injection point,
  never by scanning the whole statement — so user-authored content
  (column ``COMMENT``, view ``SELECT`` body) containing the literal words
  ``on cluster`` cannot suppress injection.
- The ``IF [NOT] EXISTS`` guard is skipped so the clause always lands after
  the object reference, regardless of whether the statement carries a guard.
"""

from __future__ import annotations

import re
from typing import Final

from chkit.core.model import MigrationPlan

# DDL statement prefixes where ``ON CLUSTER`` goes immediately after the
# object reference that follows the prefix. Anything not matched here (or by
# the trailing-anchor list below) is left untouched — e.g. plugin-emitted SQL.
#
# Anchors are the bare verb + object keyword, WITHOUT the ``IF [NOT] EXISTS``
# guard: :func:`_inject_on_cluster_clause` skips an optional guard when
# locating the object reference, so both ``DROP TABLE db.t`` and
# ``DROP TABLE IF EXISTS db.t`` are handled by the single ``DROP TABLE``
# anchor. This keeps the list resilient — a future statement is covered
# whether or not it carries a guard.
#
# The first group is what the planner + plan-pipeline emit today. The second
# is NOT emitted by chkit yet: it's a forward-compatible safety net so
# injection already works if a future command starts producing these
# statements. Every entry shares the same placement rule (clause right after
# the object identifier); placements confirmed against the ClickHouse SQL
# reference.
_ON_CLUSTER_ANCHORS: Final[tuple[str, ...]] = (
    # --- Emitted by chkit today ---
    "CREATE TABLE",
    "CREATE VIEW",
    "CREATE MATERIALIZED VIEW",
    "CREATE DATABASE",
    "CREATE DICTIONARY",
    # A structural dictionary change renders as ``CREATE OR REPLACE
    # DICTIONARY`` (there is no ``ALTER DICTIONARY``), which does NOT share
    # the ``CREATE DICTIONARY`` prefix — it needs its own anchor or ON
    # CLUSTER injection silently no-ops for every dictionary replace.
    "CREATE OR REPLACE DICTIONARY",
    "ALTER TABLE",
    "DROP TABLE",
    "DROP VIEW",
    "DROP DICTIONARY",
    # --- Not emitted by chkit yet; kept as a forward-compatible safety net ---
    "CREATE FUNCTION",
    "DROP DATABASE",
    "ATTACH TABLE",
    "DETACH TABLE",
    "TRUNCATE TABLE",
    "OPTIMIZE TABLE",
)

# Statements where ``ON CLUSTER`` goes at the very END, after the full object
# list — not after the first name. RENAME and EXCHANGE take multiple object
# references (``a TO b``, ``a AND b``), so the clause can only be appended.
# ``RENAME TABLE`` and ``RENAME DICTIONARY`` are emitted by chkit today; the
# rest are the same-family forward-compatible safety net described above.
_ON_CLUSTER_TRAILING_ANCHORS: Final[tuple[str, ...]] = (
    "RENAME TABLE",
    "RENAME DICTIONARY",
    "RENAME DATABASE",
    "EXCHANGE TABLES",
    "EXCHANGE DICTIONARIES",
)


# An optional ``IF NOT EXISTS`` / ``IF EXISTS`` guard sitting between the
# anchor keyword and the object reference. Preserved verbatim so the clause
# lands after the object, never after the guard.
_OBJECT_GUARD: Final[re.Pattern[str]] = re.compile(
    r"IF\s+(?:NOT\s+)?EXISTS\s+", re.IGNORECASE
)

# The object reference (``db.name`` or ``db``) is the run of characters up to
# the next space, ``;``, or ``(`` — ``ON CLUSTER`` slots in right after it.
_OBJECT_REF: Final[re.Pattern[str]] = re.compile(r"[^\s;(]+")

# Idempotency is checked positionally — an ``ON CLUSTER`` clause sitting
# exactly where injection would place it — never by scanning the whole
# statement, so user-authored content (a column COMMENT, a view's SELECT
# body) containing the words "on cluster" cannot suppress injection. This
# pattern is matched against the slice **after** the object reference.
_ON_CLUSTER_AT_REF: Final[re.Pattern[str]] = re.compile(
    r"\s+ON\s+CLUSTER\b", re.IGNORECASE
)

# For trailing anchors (RENAME/EXCHANGE), idempotency is checked by searching
# for ``ON CLUSTER <name>`` at the very end of the statement body.
_ON_CLUSTER_AT_END: Final[re.Pattern[str]] = re.compile(
    r"\bON\s+CLUSTER\s+\S+\s*$", re.IGNORECASE
)


def on_cluster_clause(cluster: str | None) -> str:
    """Render `` ON CLUSTER '<name>'``, or `` `` when cluster mode is off.

    The name is validated at config resolution (``_assert_valid_cluster_name``
    in :mod:`chkit.core.model`), so it is safe to interpolate. Single-quoted
    so the ``{cluster}`` macro form also works.
    """
    return f" ON CLUSTER '{cluster}'" if cluster else ""


def _inject_on_cluster_clause(sql: str, clause: str) -> str:
    # RENAME/EXCHANGE are the exception: ClickHouse places ``ON CLUSTER`` after
    # the full object list (at the very end), not after the first name. This
    # loop MUST run before the per-object anchors — ``RENAME TABLE`` would
    # otherwise be swallowed by a hypothetical prefix match.
    for anchor in _ON_CLUSTER_TRAILING_ANCHORS:
        if not sql.startswith(anchor + " "):
            continue
        body = sql[:-1] if sql.endswith(";") else sql
        # Idempotent: a trailing clause means the statement already targets
        # a cluster.
        if _ON_CLUSTER_AT_END.search(body):
            return sql
        return f"{body}{clause};" if sql.endswith(";") else f"{body}{clause}"
    for anchor in _ON_CLUSTER_ANCHORS:
        # The trailing space in ``anchor + " "`` is what disambiguates
        # ``CREATE DICTIONARY`` from ``CREATE OR REPLACE DICTIONARY`` (and any
        # other future prefix collision) — do NOT relax it to a plain
        # ``startswith(anchor)``.
        if not sql.startswith(anchor + " "):
            continue
        rest = sql[len(anchor) + 1 :]
        # Skip a leading ``IF [NOT] EXISTS`` guard, if any, so the clause is
        # placed after the object reference regardless of whether the
        # statement carries it.
        guard_match = _OBJECT_GUARD.match(rest)
        guard = guard_match.group(0) if guard_match is not None else ""
        after_guard = rest[len(guard) :]
        ref_match = _OBJECT_REF.match(after_guard)
        if ref_match is None:
            return sql
        ref = ref_match.group(0)
        after_ref = after_guard[len(ref) :]
        # Idempotent: never double-inject into a statement that already carries
        # the clause here (a plan re-run through this pass, or cluster-aware
        # plugin SQL). Match against the slice AFTER the object reference —
        # scanning the whole statement would let user content like a COMMENT
        # containing "on cluster" spuriously suppress injection.
        if _ON_CLUSTER_AT_REF.match(after_ref):
            return sql
        return f"{anchor} {guard}{ref}{clause}{after_ref}"
    return sql


def apply_on_cluster_to_plan(
    plan: MigrationPlan, cluster: str | None
) -> MigrationPlan:
    """Inject ``ON CLUSTER <name>`` into every DDL statement of a plan.

    Also rewrites the ``confirmationSQL`` on each ``renameSuggestions`` entry.
    No-op when ``cluster`` is ``None``.

    Done as a post-pass over the already-rendered SQL so the planner and
    renderers stay cluster-agnostic — ``ON CLUSTER`` is an execution directive,
    never part of the schema model or drift comparison.
    """
    if not cluster:
        return plan
    clause = on_cluster_clause(cluster)
    return plan.model_copy(
        update={
            "operations": [
                op.model_copy(update={"sql": _inject_on_cluster_clause(op.sql, clause)})
                for op in plan.operations
            ],
            "rename_suggestions": [
                suggestion.model_copy(
                    update={
                        "confirmation_sql": _inject_on_cluster_clause(
                            suggestion.confirmation_sql, clause
                        )
                    }
                )
                for suggestion in plan.rename_suggestions
            ],
        }
    )
