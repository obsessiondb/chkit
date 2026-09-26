"""Execute real CREATE/ALTER/pull/drift and compare indexed search results."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from chkit import SkipIndexText
from chkit.cli.commands.drift_compare import compare_table_shape
from chkit.cli.commands.pull_render import render_schema_file
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.introspect import list_table_details
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit.core.text_index_sql import normalize_text_index_sql
from tests.e2e_testkit import create_prefix, get_required_env
from tests.test_text_index import docs

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/text-index.json").read_text()
)


@pytest.fixture
def text_client():
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
def test_live_text_index_round_trip(text_client, case):
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
        client.execute(
            f"INSERT INTO {full_name} VALUES (1, 'alpha  beta gamma'), (2, 'alpha beta gamma'), (3, 'alpha'), (4, 'é東京😀'), (5, 'a,b=c')"
        )
        actual = next(item for item in list_table_details(client, [database]) if item.name == name)
        assert compare_table_shape(definition, actual) is None
        assert actual.indexes[0].granularity == 100000000
        namespace = {}
        exec(
            compile(
                render_schema_file([definition.model_copy(update={"indexes": actual.indexes})]),
                "schema.py",
                "exec",
            ),
            namespace,
        )
        pulled = namespace["definitions"][0]
        assert plan_diff([definition], [pulled]).operations == []
        client.execute(to_create_sql(pulled.model_copy(update={"name": name + "_clone"})))
        client.execute(f"INSERT INTO {clone_name} SELECT * FROM {full_name}")
        predicate = f"WHERE hasAllTokens({index.expression}, ['alpha']) ORDER BY id"
        original = client.query(f"SELECT id FROM {full_name} {predicate}").rows
        assert client.query(f"SELECT id FROM {clone_name} {predicate}").rows == original
        if case["name"] == "two spaces":
            assert [int(row["id"]) for row in original] == [1, 3]
    finally:
        client.execute(f"DROP TABLE IF EXISTS {full_name} SYNC")
        client.execute(f"DROP TABLE IF EXISTS {clone_name} SYNC")


def test_live_add_and_change_text_index(text_client):
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
        for before, after in ((without_index, with_index), (with_index, changed)):
            plan = plan_diff([before], [after])
            assert plan.operations
            for op in plan.operations:
                client.execute(op.sql)
            actual = next(
                item for item in list_table_details(client, [database]) if item.name == name
            )
            assert compare_table_shape(after, actual) is None
        assert "index_mismatch" in compare_table_shape(with_index, actual).reason_codes
    finally:
        client.execute(f"DROP TABLE IF EXISTS {full_name} SYNC")


def test_tuning_newer_options_and_materializing_existing_rows(text_client):
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
        client.execute(f"INSERT INTO {full_name} VALUES (1, 'hello world'), (2, 'goodbye world')")
        for op in plan_diff([without_index], [definition]).operations:
            client.execute(op.sql)
        client.execute(f"ALTER TABLE {full_name} MATERIALIZE INDEX idx SETTINGS mutations_sync = 2")
        actual = next(item for item in list_table_details(client, [database]) if item.name == name)
        assert compare_table_shape(definition, actual) is None
        namespace = {}
        exec(
            compile(
                render_schema_file([definition.model_copy(update={"indexes": actual.indexes})]),
                "schema.py",
                "exec",
            ),
            namespace,
        )
        assert plan_diff([definition], namespace["definitions"]).operations == []
        fn = "hasPhrase(body, 'hello world')" if newer_options else "hasAllTokens(body, ['hello'])"
        assert [
            int(row["id"]) for row in client.query(f"SELECT id FROM {full_name} WHERE {fn}").rows
        ] == [1]
    finally:
        client.execute(f"DROP TABLE IF EXISTS {full_name} SYNC")


def test_normalization_preserves_every_printable_clickhouse_escape(text_client):
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
