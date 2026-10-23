"""The column definition wait after MODIFY / ADD / RENAME COLUMN (#290).

Port of ``packages/clickhouse/src/alter-column-statement.test.ts`` and
``packages/clickhouse/src/ddl-propagation.test.ts``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import pytest

from chkit.clickhouse import ddl_propagation
from chkit.clickhouse.alter_column_statement import (
    ColumnIntent,
    parse_modify_column_intent,
    parse_rename_column,
)
from chkit.clickhouse.ddl_propagation import wait_for_ddl_propagation

KEY = "table:app.events:column:raw"
_FORMAT = re.compile(r"^SELECT formatQuerySingleLine\('SELECT (.*)'\) AS formatted$")


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ddl_propagation.time, "sleep", lambda _: None)


@dataclass
class _Result:
    rows: list[dict[str, Any]]


@dataclass
class _Target:
    """``replicas`` replicas behind one endpoint.

    Each poll of a system table answers with the next entry of ``polls`` (the
    last one repeats); ``formatQuerySingleLine`` answers from ``formatted``, or
    echoes its input.
    """

    polls: list[list[dict[str, Any]]]
    replicas: int = 2
    formatted: dict[str, str] = field(default_factory=dict[str, str])
    queries: list[str] = field(default_factory=list[str])
    _poll: int = 0

    def query(self, sql: str) -> _Result:
        self.queries.append(sql)
        if "system.one" in sql:
            return _Result([{"replicas": self.replicas}])
        match = _FORMAT.match(sql)
        if match:
            given = re.sub(r"\\(.)", r"\1", match.group(1))
            return _Result([{"formatted": f"SELECT {self.formatted.get(given, given)}"}])
        rows = self.polls[min(self._poll, len(self.polls) - 1)]
        self._poll += 1
        return _Result(rows)

    def polled(self, source: str) -> list[str]:
        return [q for q in self.queries if source in q and "system.one" not in q]


def _row(replica: str, **fields: str) -> dict[str, Any]:
    base = {
        "type": "String",
        "default_kind": "",
        "default_expression": "",
        "comment": "",
        "compression_codec": "",
    }
    return {"replica": replica, **base, **fields}


# ---------- parse_modify_column_intent / parse_rename_column ----------


def test_reads_the_default_kind_and_expression_up_to_the_comment_and_codec() -> None:
    assert parse_modify_column_intent(
        "ALTER TABLE app.events ON CLUSTER 'c' MODIFY COLUMN `size` Nullable(UInt64) "
        "DEFAULT length(raw) + 1 COMMENT 'it''s' CODEC(ZSTD(3));",
        "size",
    ) == ColumnIntent(default_kind="DEFAULT", default_expression="length(raw) + 1", comment="it's")


def test_keeps_nested_commas_brackets_and_keywords_inside_the_expression() -> None:
    assert parse_modify_column_intent(
        "ALTER TABLE t MODIFY COLUMN m Map(String, Array(UInt8)) MATERIALIZED map('a', [1, 2]) "
        "COMMENT 'x'",
        "m",
    ) == ColumnIntent(default_kind="MATERIALIZED", default_expression="map('a', [1, 2])", comment="x")
    assert parse_modify_column_intent(
        "ALTER TABLE t MODIFY COLUMN c String ALIAS if(a > 1, comment, b);", "c"
    ) == ColumnIntent(default_kind="ALIAS", default_expression="if(a > 1, comment, b)")


def test_reads_an_ephemeral_default_and_a_bare_ephemeral() -> None:
    assert parse_modify_column_intent(
        "ALTER TABLE t MODIFY COLUMN `raw` String EPHEMERAL 'seed';", "raw"
    ) == ColumnIntent(default_kind="EPHEMERAL", default_expression="'seed'")
    assert parse_modify_column_intent(
        "ALTER TABLE t MODIFY COLUMN `raw` String EPHEMERAL;", "raw"
    ) == ColumnIntent(default_kind="EPHEMERAL", type_default=True)


def test_sets_nothing_a_type_only_modify_leaves_in_place() -> None:
    assert parse_modify_column_intent(
        "ALTER TABLE t MODIFY COLUMN `code` UInt64 CODEC(Delta, ZSTD);", "code"
    ) == ColumnIntent()


def test_reads_remove_of_a_default_a_codec_and_a_comment() -> None:
    statement = "ALTER TABLE t MODIFY COLUMN `day` REMOVE {};"
    assert parse_modify_column_intent(statement.format("MATERIALIZED"), "day") == ColumnIntent(
        default_kind=""
    )
    assert parse_modify_column_intent(statement.format("CODEC"), "day") == ColumnIntent(
        codec_removed=True
    )
    assert parse_modify_column_intent(statement.format("COMMENT"), "day") == ColumnIntent(comment="")


def test_sets_nothing_for_another_column_or_another_statement() -> None:
    assert parse_modify_column_intent("ALTER TABLE t MODIFY COLUMN a String DEFAULT 'x';", "b") == (
        ColumnIntent()
    )
    assert parse_modify_column_intent("ALTER TABLE t ADD COLUMN a String DEFAULT 'x';", "a") == (
        ColumnIntent()
    )
    assert parse_modify_column_intent(
        "ALTER TABLE t MODIFY COLUMN a String DEFAULT 'x' -- note\n;", "a"
    ) == ColumnIntent(default_kind="DEFAULT", default_expression="'x'")


def test_parse_rename_column_reads_quoted_and_bare_names() -> None:
    assert parse_rename_column(
        "ALTER TABLE app.t RENAME COLUMN IF EXISTS `a:b` TO `c\\`d`;"
    ) == ("a:b", "c`d")
    assert parse_rename_column("ALTER TABLE app.t RENAME COLUMN x TO y") == ("x", "y")
    assert parse_rename_column("RENAME TABLE a TO b") is None


# ---------- MODIFY COLUMN waits for the definition it sets ----------


def test_keeps_waiting_while_a_replica_still_reports_the_old_default_expression() -> None:
    new = {"default_kind": "DEFAULT", "default_expression": "'new'"}
    old = {"default_kind": "DEFAULT", "default_expression": "'old'"}
    target = _Target([[_row("r1", **new), _row("r2", **old)], [_row("r1", **new), _row("r2", **new)]])

    wait_for_ddl_propagation(
        target,
        "alter_table_modify_column",
        KEY,
        statement="ALTER TABLE app.events MODIFY COLUMN `raw` String DEFAULT 'new';",
    )

    polls = target.polled("system.columns")
    assert len(polls) == 2
    assert "clusterAllReplicas('default', system.columns)" in polls[0]
    assert "name = 'raw'" in polls[0]
    assert [q for q in target.queries if "formatQuerySingleLine" in q] == [
        "SELECT formatQuerySingleLine('SELECT \\'new\\'') AS formatted"
    ]


def test_compares_the_default_expression_as_the_server_formats_it() -> None:
    applied = {"default_kind": "MATERIALIZED", "default_expression": "concat(a + 1, b)"}
    target = _Target(
        [[_row("r1", **applied), _row("r2", **applied)]],
        formatted={"a+1 || b": "concat(a + 1, b)"},
    )

    wait_for_ddl_propagation(
        target,
        "alter_table_modify_column",
        KEY,
        statement="ALTER TABLE app.events MODIFY COLUMN `raw` UInt64 MATERIALIZED a+1 || b;",
    )

    assert len(target.polled("system.columns")) == 1


def test_waits_until_every_replica_reports_the_same_type() -> None:
    target = _Target(
        [
            [_row("r1", type="Decimal(10, 2)"), _row("r2", type="Decimal(9, 2)")],
            [_row("r1", type="Decimal(10, 2)"), _row("r2", type="Decimal(10, 2)")],
        ]
    )

    wait_for_ddl_propagation(
        target,
        "alter_table_modify_column",
        KEY,
        statement="ALTER TABLE app.events MODIFY COLUMN `raw` Decimal(10,2);",
    )

    assert len(target.polled("system.columns")) == 2


def test_waits_until_every_replica_lists_the_column() -> None:
    target = _Target([[_row("r1")], [_row("r1"), _row("r2")]])

    wait_for_ddl_propagation(
        target,
        "alter_table_modify_column",
        KEY,
        statement="ALTER TABLE app.events MODIFY COLUMN `raw` String;",
    )

    assert len(target.polled("system.columns")) == 2


def test_waits_for_remove_of_a_default_a_codec_and_a_comment() -> None:
    removed = _Target(
        [[_row("r1"), _row("r2", default_kind="DEFAULT", default_expression="'x'")], [_row("r1"), _row("r2")]]
    )
    wait_for_ddl_propagation(
        removed,
        "alter_table_modify_column",
        KEY,
        statement="ALTER TABLE app.events MODIFY COLUMN `raw` REMOVE DEFAULT;",
    )
    assert len(removed.polled("system.columns")) == 2

    zstd = "CODEC(ZSTD(1))"
    codec = _Target(
        [[_row("r1", compression_codec=zstd), _row("r2", compression_codec=zstd)], [_row("r1"), _row("r2")]]
    )
    wait_for_ddl_propagation(
        codec,
        "alter_table_modify_column",
        KEY,
        statement="ALTER TABLE app.events MODIFY COLUMN `raw` REMOVE CODEC;",
    )
    assert len(codec.polled("system.columns")) == 2

    comment = _Target(
        [
            [_row("r1", comment="old"), _row("r2", comment="old")],
            [_row("r1", comment="it's"), _row("r2", comment="it's")],
        ]
    )
    wait_for_ddl_propagation(
        comment,
        "alter_table_modify_column",
        KEY,
        statement="ALTER TABLE app.events MODIFY COLUMN `raw` String COMMENT 'it''s';",
    )
    assert len(comment.polled("system.columns")) == 2


def test_waits_for_a_bare_ephemeral_to_store_the_type_default() -> None:
    seeded = {"default_kind": "EPHEMERAL", "default_expression": "'seed'"}
    typed = {"default_kind": "EPHEMERAL", "default_expression": "defaultValueOfTypeName('String')"}
    target = _Target([[_row("r1", **seeded), _row("r2", **seeded)], [_row("r1", **typed), _row("r2", **typed)]])

    wait_for_ddl_propagation(
        target,
        "alter_table_modify_column",
        KEY,
        statement="ALTER TABLE app.events MODIFY COLUMN `raw` String EPHEMERAL;",
    )

    assert len(target.polled("system.columns")) == 2


def test_checks_the_definition_on_a_single_replica_target_too() -> None:
    target = _Target(
        [
            [_row("h", default_kind="DEFAULT", default_expression="'old'")],
            [_row("h", default_kind="DEFAULT", default_expression="'new'")],
        ],
        replicas=1,
    )

    wait_for_ddl_propagation(
        target,
        "alter_table_modify_column",
        KEY,
        statement="ALTER TABLE app.events MODIFY COLUMN `raw` String DEFAULT 'new';",
    )

    polls = target.polled("system.columns")
    assert len(polls) == 2
    assert "clusterAllReplicas" not in polls[0]


def test_names_the_field_and_says_it_is_not_lag_when_every_replica_kept_the_old_definition() -> None:
    kept = {"default_kind": "EPHEMERAL", "default_expression": "defaultValueOfTypeName('String')"}
    target = _Target([[_row("r1", **kept), _row("r2", **kept)]])

    with pytest.raises(RuntimeError) as raised:
        wait_for_ddl_propagation(
            target,
            "alter_table_modify_column",
            KEY,
            statement="ALTER TABLE app.events MODIFY COLUMN `raw` String EPHEMERAL 'seed';",
        )

    assert str(raised.value) == (
        "wait_for_ddl_propagation: app.events.raw definition not applied on every replica "
        "after 21 checks: replica r1 reports default_expression "
        "\"defaultValueOfTypeName('String')\", the statement sets \"'seed'\"; every replica "
        "reports the same, so this is not replication lag: the server accepted the statement "
        "without applying it"
    )


def test_names_the_replica_and_field_that_still_differ_when_replicas_disagree() -> None:
    target = _Target([[_row("r1", type="UInt64"), _row("r2", type="UInt32")]])

    with pytest.raises(
        RuntimeError,
        match='after 21 checks: replica r2 reports type "UInt32", replica r1 reports "UInt64"',
    ):
        wait_for_ddl_propagation(
            target,
            "alter_table_modify_column",
            KEY,
            statement="ALTER TABLE app.events MODIFY COLUMN `raw` UInt64;",
        )


# ---------- other column operations ----------


def test_add_column_waits_for_agreement_without_checking_what_the_statement_sets() -> None:
    target = _Target([[_row("r1", comment="old"), _row("r2")], [_row("r1"), _row("r2")]])

    wait_for_ddl_propagation(
        target,
        "alter_table_add_column",
        KEY,
        statement="ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `raw` String DEFAULT 'x' COMMENT 'c';",
    )

    assert len(target.polled("system.columns")) == 2
    assert not any("formatQuerySingleLine" in q for q in target.queries)


def test_rename_column_waits_until_only_the_new_name_is_listed_on_every_replica() -> None:
    target = _Target(
        [
            [{"replica": "r1", "name": "c"}, {"replica": "r2", "name": "a:b"}],
            [{"replica": "r1", "name": "c"}],
            [{"replica": "r1", "name": "c"}, {"replica": "r2", "name": "c"}],
        ]
    )

    wait_for_ddl_propagation(
        target,
        "alter_table_rename_column",
        "table:app.events:column_rename:a:b:c",
        statement="ALTER TABLE app.events RENAME COLUMN IF EXISTS `a:b` TO `c`;",
    )

    polls = target.polled("system.columns")
    assert len(polls) == 3
    assert "name IN ('a:b', 'c')" in polls[0]


def test_rename_column_without_the_statement_splits_a_key_with_one_colon() -> None:
    target = _Target([[{"replica": "r1", "name": "y"}, {"replica": "r2", "name": "y"}]])

    wait_for_ddl_propagation(target, "alter_table_rename_column", "table:app.events:column_rename:x:y")

    assert "name IN ('x', 'y')" in target.polled("system.columns")[0]
