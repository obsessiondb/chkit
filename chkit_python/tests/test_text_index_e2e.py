"""Execute real CREATE/ALTER/pull/drift and compare indexed search results."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any, TypeAlias

import pytest

from chkit import SkipIndexText
from chkit.cli.commands.drift_compare import compare_table_shape
from chkit.cli.commands.pull_render import render_schema_file
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_table
from chkit.clickhouse.introspect import IntrospectedTable, list_table_details
from chkit.core.model import ChxResolvedClickHouseConfig, TableDefinition
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit.core.text_index import text_index_fingerprint
from chkit.core.text_index_sql import normalize_text_index_sql
from tests.e2e_testkit import create_prefix, get_required_env, poll_until, run_once_visible
from tests.test_text_index import docs

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/text-index.json").read_text()
)


TextClient: TypeAlias = tuple[ClickHouseClient, str]

ROWS = "(1, 'alpha  beta gamma'), (2, 'alpha beta gamma'), (3, 'alpha'), (4, 'é東京😀'), (5, 'a,b=c')"
ROW_COUNT = 5


def _find_table(client: ClickHouseClient, database: str, name: str) -> IntrospectedTable | None:
    return next((item for item in list_table_details(client, [database]) if item.name == name), None)


def _load_pulled(definition: TableDefinition) -> TableDefinition:
    namespace: dict[str, Any] = {}
    exec(compile(render_schema_file([definition]), "schema.py", "exec"), namespace)
    return namespace["definitions"][0]


@pytest.fixture
def text_client() -> Iterator[TextClient]:
    env = get_required_env()
    with ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    ) as client:
        yield client, env.clickhouse_database


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_live_text_index_round_trip(text_client: TextClient, case: dict[str, Any]) -> None:
    client, database = text_client
    name = create_prefix("py_text") + "docs"
    params = {key: value for key, value in case.items() if key != "name"}
    index = SkipIndexText.model_validate(
        {"name": "idx", "expression": "body", "granularity": 1, **params}
    )
    definition = docs(index, name=name, database=database)
    full_name = f"{database}.{name}"
    clone_name = f"{database}.{name}_clone"
    try:
        pre = f", preprocessor = {index.preprocessor}" if index.preprocessor else ""
        client.execute(
            f"CREATE TABLE {full_name} (id UInt64, body String, INDEX idx ({index.expression}) "
            f"TYPE text(tokenizer = {index.tokenizer}{pre}) GRANULARITY 1) ENGINE=MergeTree ORDER BY id"
        )
        wait_for_table(client, database, name)
        run_once_visible(lambda: client.execute(f"INSERT INTO {full_name} VALUES {ROWS}"))
        actual = poll_until(lambda: _find_table(client, database, name), lambda item: item is not None)
        assert actual is not None
        assert compare_table_shape(definition, actual) is None
        assert actual.indexes[0].granularity == 100000000
        pulled = _load_pulled(definition.model_copy(update={"indexes": actual.indexes}))
        assert plan_diff([definition], [pulled]).operations == []
        client.execute(to_create_sql(pulled.model_copy(update={"name": name + "_clone"})))
        wait_for_table(client, database, name + "_clone")
        # Insert the rows directly rather than INSERT ... SELECT from the
        # original: on a multi-replica service the copy can run on a replica
        # that hasn't seen the original's rows yet and copy nothing.
        run_once_visible(lambda: client.execute(f"INSERT INTO {clone_name} VALUES {ROWS}"))

        # Read both tables in one query so both come from the same replica, and
        # re-read until that replica sees every row of both.
        def search(target: str) -> str:
            return (
                f"(SELECT groupArray(id) FROM (SELECT id FROM {target} "
                f"WHERE hasAllTokens({index.expression}, ['alpha']) ORDER BY id))"
            )

        observed = poll_until(
            lambda: client.query(
                f"SELECT [(SELECT count() FROM {full_name}), (SELECT count() FROM {clone_name})] "
                f"AS counts, {search(full_name)} AS original, {search(clone_name)} AS clone"
            ).rows[0],
            # The text index can trail the rows it covers on a fresh replica, so
            # also wait for the clone's results to match; on timeout the last
            # observation is returned and a real mismatch fails below.
            lambda row: all(int(count) == ROW_COUNT for count in row["counts"])
            and list(row["clone"]) == list(row["original"]),
        )
        assert [int(count) for count in observed["counts"]] == [ROW_COUNT, ROW_COUNT]
        assert list(observed["clone"]) == list(observed["original"])
        if case["name"] == "two spaces":
            assert [int(item) for item in observed["original"]] == [1, 3]
    finally:
        client.execute(f"DROP TABLE IF EXISTS {full_name} SYNC")
        client.execute(f"DROP TABLE IF EXISTS {clone_name} SYNC")


def test_live_add_and_change_text_index(text_client: TextClient) -> None:
    client, database = text_client
    name = create_prefix("py_text_alter") + "docs"
    full_name = f"{database}.{name}"
    index = SkipIndexText(
        name="idx", expression="body", tokenizer="splitByString(['  '])", granularity=1
    )
    with_index = docs(index, name=name, database=database)
    without_index = with_index.model_copy(update={"indexes": []})
    changed = with_index.model_copy(
        update={"indexes": [index.model_copy(update={"tokenizer": "splitByString([' '])"})]}
    )
    try:
        client.execute(to_create_sql(without_index))
        wait_for_table(client, database, name)
        for before, after in ((without_index, with_index), (with_index, changed)):
            plan = plan_diff([before], [after])
            assert plan.operations
            for op in plan.operations:
                run_once_visible(lambda sql=op.sql: client.execute(sql))
            actual = poll_until(
                lambda: _find_table(client, database, name),
                lambda item, target=after: item is not None
                and compare_table_shape(target, item) is None,
            )
            assert actual is not None
            assert compare_table_shape(after, actual) is None
        assert "index_mismatch" in compare_table_shape(with_index, actual).reason_codes
    finally:
        client.execute(f"DROP TABLE IF EXISTS {full_name} SYNC")


def test_tuning_newer_options_and_materializing_existing_rows(text_client: TextClient) -> None:
    client, database = text_client
    version = str(client.query("SELECT version() AS version").rows[0]["version"])
    newer_options = tuple(int(part) for part in version.split(".")[:2]) >= (26, 8)
    name = create_prefix("py_text_options") + "docs"
    full_name = f"{database}.{name}"
    index = SkipIndexText(
        name="idx",
        expression="body",
        tokenizer="splitByNonAlpha",
        dictionary_block_size=512,
        dictionary_block_frontcoding_compression=False,
        posting_list_block_size=1024,
        posting_list_codec="bitpacking",
        postprocessor="lower(body)" if newer_options else None,
        support_phrase_search=True if newer_options else None,
    )
    definition = docs(index, name=name, database=database)
    if newer_options:
        definition = definition.model_copy(
            update={"settings": {"allow_experimental_text_index_phrase_search": 1}}
        )
    without_index = definition.model_copy(update={"indexes": []})
    try:
        client.execute(to_create_sql(without_index))
        wait_for_table(client, database, name)
        run_once_visible(
            lambda: client.execute(
                f"INSERT INTO {full_name} VALUES (1, 'hello world'), (2, 'goodbye world')"
            )
        )
        for op in plan_diff([without_index], [definition]).operations:
            run_once_visible(lambda sql=op.sql: client.execute(sql))
        run_once_visible(
            lambda: client.execute(
                f"ALTER TABLE {full_name} MATERIALIZE INDEX idx SETTINGS mutations_sync = 2"
            )
        )
        actual = poll_until(
            lambda: _find_table(client, database, name),
            lambda item: item is not None and compare_table_shape(definition, item) is None,
        )
        assert actual is not None
        assert compare_table_shape(definition, actual) is None
        pulled = _load_pulled(definition.model_copy(update={"indexes": actual.indexes}))
        assert plan_diff([definition], [pulled]).operations == []
        fn = "hasPhrase(body, 'hello world')" if newer_options else "hasAllTokens(body, ['hello'])"
        ids = poll_until(
            lambda: [
                int(row["id"])
                for row in client.query(f"SELECT id FROM {full_name} WHERE {fn}").rows
            ],
            lambda value: value == [1],
        )
        assert ids == [1]
    finally:
        client.execute(f"DROP TABLE IF EXISTS {full_name} SYNC")


def test_normalization_preserves_every_printable_clickhouse_escape(
    text_client: TextClient,
) -> None:
    client, _ = text_client
    for code in range(32, 127):
        sql = "'\\" + chr(code) + "'"
        if code == 120:
            with pytest.raises(ValueError, match="Invalid hexadecimal"):
                normalize_text_index_sql(sql)
            continue
        rows = client.query(
            f"SELECT hex({sql}) AS original, hex({normalize_text_index_sql(sql)}) AS normalized"
        ).rows
        assert rows[0]["normalized"] == rows[0]["original"], repr(sql)


def test_quoted_literal_names_remain_distinct_from_constants(text_client: TextClient) -> None:
    client, _ = text_client
    for word in ("null", "true", "false", "inf", "infinity", "nan"):
        for name in (word, word.upper(), word.capitalize()):
            quoted, unquoted = f"toString(`{name}`)", f"toString({name})"
            rows = client.query(
                f"SELECT {quoted} AS quoted_value, {unquoted} AS literal_value "
                f"FROM (SELECT 'sentinel' AS `{name}`)"
            ).rows
            assert rows[0]["quoted_value"] == "sentinel"
            assert rows[0]["literal_value"] != "sentinel"
            index = SkipIndexText(name="idx", expression=quoted, tokenizer="splitByNonAlpha")
            assert text_index_fingerprint(index) != text_index_fingerprint(
                index.model_copy(update={"expression": unquoted})
            )


def test_quoted_null_column_round_trips_and_literal_change_migrates(
    text_client: TextClient,
) -> None:
    client, database = text_client
    name = create_prefix("py_text_keyword") + "docs"
    full_name = f"{database}.{name}"
    index = SkipIndexText(
        name="idx",
        tokenizer="splitByNonAlpha",
        expression="concat(body, ifNull(\"NULL\", 'missing'))",
    )
    base = docs(index, name=name, database=database)
    definition = type(base).model_validate(
        {**base.model_dump(), "columns": [*base.columns, {"name": "NULL", "type": "String"}]}
    )
    changed_index = index.model_copy(update={"expression": "concat(body, ifNull(NULL, 'missing'))"})
    changed = definition.model_copy(update={"indexes": [changed_index]})

    def settled(target: TableDefinition) -> IntrospectedTable:
        found = poll_until(
            lambda: _find_table(client, database, name),
            lambda item: item is not None and compare_table_shape(target, item) is None,
        )
        assert found is not None
        return found

    def search(expression: str) -> list[int]:
        return [
            int(row["id"])
            for row in client.query(
                f"SELECT id FROM {full_name} WHERE hasAllTokens({expression}, ['alpha'])"
            ).rows
        ]

    try:
        client.execute(to_create_sql(definition))
        wait_for_table(client, database, name)
        run_once_visible(lambda: client.execute(f"INSERT INTO {full_name} VALUES (1, 'doc ', 'alpha')"))
        actual = settled(definition)
        assert compare_table_shape(definition, actual) is None
        assert "index_mismatch" in compare_table_shape(changed, actual).reason_codes
        pulled = _load_pulled(definition.model_copy(update={"indexes": actual.indexes}))
        assert plan_diff([definition], [pulled]).operations == []
        assert poll_until(lambda: search(index.expression), lambda ids: ids == [1]) == [1]
        plan = plan_diff([pulled], [changed])
        assert [op.type for op in plan.operations] == [
            "alter_table_drop_index",
            "alter_table_add_index",
        ]
        for op in plan.operations:
            run_once_visible(lambda sql=op.sql: client.execute(sql))
        run_once_visible(
            lambda: client.execute(
                f"ALTER TABLE {full_name} MATERIALIZE INDEX idx SETTINGS mutations_sync = 2"
            )
        )
        assert compare_table_shape(changed, settled(changed)) is None
        assert search(changed_index.expression) == []
    finally:
        client.execute(f"DROP TABLE IF EXISTS {full_name} SYNC")
