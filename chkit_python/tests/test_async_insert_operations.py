from chkit.cli.safety_markers import MigrationOperationSummary, async_insert_operations


def test_unmarked_insert_select_keeps_journal_positions_and_ignores_literals() -> None:
    statements = [
        "CREATE TABLE t (x UInt8)",
        "INSERT /* source */ INTO t SELECT 1",
        "INSERT INTO t VALUES ('SELECT')",
    ]
    operations = async_insert_operations(statements, [])
    assert operations[0].mode == "sync"
    assert operations[1].mode == "async"
    assert operations[1].key == "statement:1"
    assert operations[2].mode == "sync"


def test_explicit_execution_mode_and_compensation_are_preserved() -> None:
    operation = MigrationOperationSummary(
        type="load",
        key="table:db.t",
        risk="caution",
        mode="sync",
        before_retry="TRUNCATE TABLE t",
        summary="explicit",
    )
    assert async_insert_operations(["INSERT INTO t SELECT 1"], [operation]) == [operation]
