"""Port of ``packages/cli/src/commands/generate/codec-warnings.test.ts`` (#465)."""

from __future__ import annotations

from chkit.cli.commands.codec_warnings import detect_experimental_codec_warnings
from chkit.core.model import MigrationOperation, MigrationPlan


def _plan_of(sql: list[str]) -> MigrationPlan:
    return MigrationPlan(
        operations=[
            MigrationOperation(
                type="alter_table_modify_column",
                key=f"table:app.events:column:c{i}",
                risk="caution",
                sql=statement,
            )
            for i, statement in enumerate(sql)
        ],
        riskSummary={"safe": 0, "caution": len(sql), "danger": 0},
        renameSuggestions=[],
    )


def test_warns_about_each_operation_that_sets_the_alp_codec() -> None:
    plan = _plan_of([
        "ALTER TABLE app.events MODIFY COLUMN `c0` Float64 CODEC(ALP);",
        "ALTER TABLE app.events MODIFY COLUMN `c1` Float64 CODEC(Delta(8), ALP, ZSTD(1));",
        "ALTER TABLE app.events MODIFY COLUMN `c2` Float64 CODEC(Gorilla);",
        "ALTER TABLE app.events MODIFY COLUMN `c3` String DEFAULT 'ALP' CODEC(ZSTD(1));",
    ])
    assert detect_experimental_codec_warnings(plan) == [
        f"table:app.events:column:c{i} uses the experimental ALP codec, which ClickHouse rejects "
        "unless allow_experimental_codecs is 1. Apply it with chkit migrate --apply "
        "--setting allow_experimental_codecs=1."
        for i in (0, 1)
    ]
