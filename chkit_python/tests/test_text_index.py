"""Shared adversarial corpus exercises both Python and TypeScript implementations."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from chkit import SkipIndexText, table
from chkit.cli.commands.pull_render import render_schema_file
from chkit.core.canonical import canonicalize_definitions
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit.core.text_index import (
    canonicalize_text_index,
    parse_text_index_params,
    render_text_index_type,
)
from chkit.core.text_index_sql import normalize_text_index_sql
from chkit.core.validate import validate_definitions

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/text-index.json").read_text()
)


def docs(index, name="docs", database="app"):
    return table(
        database=database,
        name=name,
        engine="MergeTree()",
        columns=[{"name": "id", "type": "UInt64"}, {"name": "body", "type": "String"}],
        primary_key=["id"],
        order_by=["id"],
        indexes=[index],
    )


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_text_round_trip(case):
    params = {key: value for key, value in case.items() if key != "name"}
    index = SkipIndexText.model_validate({"name": "idx", "expression": "body", **params})
    sql = render_text_index_type(index)
    parsed = index.model_copy(update=parse_text_index_params(sql[5:-1]))
    assert render_text_index_type(parsed) == sql
    assert canonicalize_text_index(canonicalize_text_index(index)) == canonicalize_text_index(index)
    namespace = {}
    exec(compile(render_schema_file([docs(index)]), "schema.py", "exec"), namespace)
    assert canonicalize_definitions(namespace["definitions"]) == canonicalize_definitions(
        [docs(index)]
    )


def test_literal_whitespace_changes_require_migrations():
    index = SkipIndexText(
        name="idx",
        expression="body",
        tokenizer="splitByString(['  '])",
        preprocessor="replaceAll(body, '  ', ' ')",
    )
    original = docs(index)
    assert "splitByString(['  '])" in to_create_sql(original)
    for change in (
        {"tokenizer": "splitByString([' '])"},
        {"preprocessor": "replaceAll(body, ' ', ' ')"},
    ):
        changed = docs(index.model_copy(update=change))
        assert [op.type for op in plan_diff([original], [changed]).operations] == [
            "alter_table_drop_index",
            "alter_table_add_index",
        ]


@pytest.mark.parametrize("granularity", [1, 64, 100000000])
def test_granularity_does_not_change_schema(granularity):
    index = SkipIndexText(name="idx", expression="body", tokenizer="splitByNonAlpha")
    changed = docs(index.model_copy(update={"granularity": granularity}))
    assert "GRANULARITY 100000000" in to_create_sql(changed)
    assert plan_diff([docs(index)], [changed]).operations == []


def test_equivalent_escapes():
    assert normalize_text_index_sql("splitByString(['\t', 'é', ''''])") == normalize_text_index_sql(
        r"splitByString(['\x09', '\xc3\xa9', '\''])"
    )


@pytest.mark.parametrize(
    "args",
    [
        "",
        "tokenizer =",
        "tokenizer = ngrams(3",
        "tokenizer = 'oops",
        "tokenizer = ngrams(3],)",
        "tokenizer = splitByNonAlpha,",
        "tokenizer = splitByNonAlpha, tokenizer = ngrams(2)",
        "tokenizer = splitByNonAlpha, unknown = 1",
        "tokenizer = splitByNonAlpha, support_phrase_search = 2",
        "tokenizer = splitByNonAlpha, dictionary_block_size = 0",
        "tokenizer = splitByNonAlpha, dictionary_block_size = 1.5",
        "tokenizer = splitByNonAlpha, dictionary_block_size = 9007199254740992",
        "tokenizer = splitByNonAlpha, posting_list_codec = 'bogus'",
        "tokenizer = splitByNonAlpha; SELECT 1",
        "tokenizer = /* unclosed",
    ],
)
def test_rejects_lossy_or_malformed_metadata(args):
    with pytest.raises(ValueError, match=r".+"):
        parse_text_index_params(args)


@pytest.mark.parametrize(
    "params",
    [
        {"tokenizer": ""},
        {"tokenizer": "/*empty*/"},
        {"dictionary_block_size": -1},
        {"posting_list_block_size": 0},
        {"preprocessor": ""},
    ],
)
def test_validation_reports_invalid_parameters(params):
    index = SkipIndexText.model_validate(
        {"name": "idx", "expression": "body", "tokenizer": "splitByNonAlpha", **params}
    )
    assert "text_index_invalid_parameters" in [
        issue.code for issue in validate_definitions([docs(index)])
    ]


def test_all_options_and_parameter_order():
    index = SkipIndexText(
        name="idx",
        expression="concat(body, ')  (')",
        tokenizer="splitByNonAlpha",
        postprocessor="lower(body)",
        support_phrase_search=False,
        dictionary_block_frontcoding_compression=False,
        dictionary_block_size=512,
        posting_list_block_size=1024,
        posting_list_codec="bitpacking",
    )
    sql = render_text_index_type(index)
    assert "support_phrase_search = 0" in sql
    pulled = index.model_copy(update=parse_text_index_params(sql[5:-1]))
    assert pulled == index


def test_identifier_quotes_do_not_rebuild_or_conflate_string_literals():
    index = SkipIndexText(
        name="idx", expression="body", tokenizer="splitByNonAlpha", preprocessor="lower(`body`)"
    )
    unquoted = index.model_copy(update={"preprocessor": "lower(body)"})
    literal = index.model_copy(update={"preprocessor": "lower('body')"})
    assert plan_diff([docs(index)], [docs(unquoted)]).operations == []
    assert len(plan_diff([docs(index)], [docs(literal)]).operations) == 2
