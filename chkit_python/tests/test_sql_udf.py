"""Parity with the scalar SQL UDF binding regressions in sql-udf.test.ts."""

from chkit.clickhouse.sql_udf import SQLUDF, expand_sql_udfs, parse_sql_udf


def _definitions(*queries: str) -> dict[str, SQLUDF]:
    definitions: dict[str, SQLUDF] = {}
    for query in queries:
        definition = parse_sql_udf(query)
        assert definition is not None
        definitions[query.split(" ")[2]] = definition
    return definitions


def test_scalar_substitution_preserves_precedence_arrays_maps_and_quotes() -> None:
    functions = _definitions("CREATE FUNCTION f AS (x, y) -> x - y")
    assert expand_sql_udfs("SELECT f(a + b, c * d)", functions) == "SELECT (a + b) - (c * d)"
    tuple_function = _definitions("CREATE FUNCTION f AS (x, y) -> tuple(x, y, 'x', `x`)")
    assert expand_sql_udfs("SELECT f([1, 2], map('a,b', [3,4]))", tuple_function) == (
        "SELECT tuple([1, 2], map('a,b', [3,4]), 'x', [1, 2])"
    )


def test_only_exact_unqualified_function_calls_expand() -> None:
    functions = _definitions("CREATE FUNCTION f AS (x) -> x + 1")
    query = "SELECT db.f(x), F(x), 'f(x)', f"
    assert expand_sql_udfs(query, functions) == query


def test_nested_functions_expand_and_recursive_definitions_fail_closed() -> None:
    functions = _definitions("CREATE FUNCTION f AS x -> (x + 1)", "CREATE FUNCTION g AS y -> f(y)")
    expanded = expand_sql_udfs("SELECT g(a)", functions)
    assert expanded is not None
    assert "f(" not in expanded
    assert "g(" not in expanded
    nested = expand_sql_udfs("SELECT f(f(a))", functions)
    assert nested is not None
    assert "f(" not in nested
    recursive = _definitions("CREATE FUNCTION f AS (x) -> f(x)")
    assert expand_sql_udfs("SELECT f(a)", recursive) is None
    assert expand_sql_udfs("SELECT f(a,b)", functions) is None
    assert expand_sql_udfs("SELECT " + "f(" * 70 + "a" + ")" * 70, functions) is None


def test_definitions_introducing_scopes_or_aliases_stay_unsupported() -> None:
    for query in (
        "CREATE FUNCTION f AS (x) -> arrayMap(x -> x + 1, x)",
        "CREATE FUNCTION f AS (x) -> (SELECT x)",
        "CREATE FUNCTION f AS (x) -> x AS label",
        "CREATE FUNCTION f AS (x, x) -> x",
    ):
        assert parse_sql_udf(query) is None


def test_arithmetic_expansion_wraps_operands_but_not_complete_projection() -> None:
    functions = _definitions("CREATE FUNCTION f AS (x, y) -> x - y")
    assert expand_sql_udfs("SELECT c, f(a, b) AS value FROM t", functions) == "SELECT c, a - b AS value FROM t"
    assert expand_sql_udfs("SELECT toString(f(a, b)) FROM t", functions) == "SELECT toString(a - b) FROM t"
    assert expand_sql_udfs("SELECT f(a, b) AS value FROM t", functions) == "SELECT a - b AS value FROM t"
    assert expand_sql_udfs("SELECT f(a, b) * c FROM t", functions) == "SELECT (a - b) * c FROM t"
    assert expand_sql_udfs("SELECT c - f(a, b) FROM t", functions) == "SELECT c - (a - b) FROM t"


def test_stored_scalar_parentheses_preserve_tuple_expressions() -> None:
    functions = _definitions("CREATE FUNCTION f AS x -> ((x + 1))", "CREATE FUNCTION g AS x -> (x, x)")
    assert expand_sql_udfs("SELECT f(a) AS x", functions) == "SELECT a + 1 AS x"
    assert expand_sql_udfs("SELECT g(a) AS x", functions) == "SELECT (a, a) AS x"
