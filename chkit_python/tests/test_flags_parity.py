"""1:1 port of ``packages/core/src/flags.test.ts``."""

from __future__ import annotations

import pytest

from chkit.core.flags import (
    FlagDef,
    MissingFlagValueError,
    UnknownFlagError,
    define_flags,
    parse_flags,
)

DEFS: list[FlagDef] = [
    {"name": "--name", "type": "string", "description": "Migration name", "placeholder": "<name>"},
    {"name": "--dryrun", "type": "boolean", "description": "Dry run"},
    {"name": "--json", "type": "boolean", "description": "JSON output"},
    {"name": "--database", "type": "string[]", "description": "Databases"},
    {"name": "--emit-zod", "type": "boolean", "description": "Emit Zod", "negation": True},
]


def test_parses_string_flags() -> None:
    result = parse_flags(["--name", "my-migration"], DEFS)
    assert result["--name"] == "my-migration"


def test_parses_boolean_flags() -> None:
    result = parse_flags(["--dryrun", "--json"], DEFS)
    assert result["--dryrun"] is True
    assert result["--json"] is True


def test_parses_string_array_flags_with_comma_splitting() -> None:
    result = parse_flags(["--database", "db1,db2"], DEFS)
    assert result["--database"] == ["db1", "db2"]


def test_accumulates_repeated_string_array_flags() -> None:
    result = parse_flags(
        ["--database", "db1", "--database", "db2,db3"], DEFS
    )
    assert result["--database"] == ["db1", "db2", "db3"]


def test_parses_negation_flags() -> None:
    result = parse_flags(["--no-emit-zod"], DEFS)
    assert result["--emit-zod"] is False


def test_positive_overrides_negation() -> None:
    result = parse_flags(["--no-emit-zod", "--emit-zod"], DEFS)
    assert result["--emit-zod"] is True


def test_returns_empty_for_no_flags() -> None:
    result = parse_flags([], DEFS)
    assert result == {}


def test_ignores_positional_args() -> None:
    result = parse_flags(["generate", "--name", "foo", "extra"], DEFS)
    assert result["--name"] == "foo"


def test_throws_unknown_flag_error() -> None:
    with pytest.raises(UnknownFlagError):
        parse_flags(["--typo"], DEFS)


def test_throws_missing_value_for_string_flag_without_value() -> None:
    with pytest.raises(MissingFlagValueError):
        parse_flags(["--name"], DEFS)


def test_throws_missing_value_when_next_token_is_a_flag() -> None:
    with pytest.raises(MissingFlagValueError):
        parse_flags(["--name", "--dryrun"], DEFS)


def test_handles_mixed_flags_and_positionals() -> None:
    result = parse_flags(
        ["generate", "--dryrun", "--name", "test", "--database", "a,b"], DEFS
    )
    assert result["--dryrun"] is True
    assert result["--name"] == "test"
    assert result["--database"] == ["a", "b"]


def test_last_string_flag_wins() -> None:
    result = parse_flags(["--name", "first", "--name", "second"], DEFS)
    assert result["--name"] == "second"


def test_parses_equals_form_for_string_flags() -> None:
    result = parse_flags(["--name=my-migration"], DEFS)
    assert result["--name"] == "my-migration"


def test_accepts_empty_value_for_equals_form() -> None:
    result = parse_flags(["--name="], DEFS)
    assert result["--name"] == ""


def test_parses_equals_form_for_string_array_flags() -> None:
    result = parse_flags(["--database=db1,db2"], DEFS)
    assert result["--database"] == ["db1", "db2"]


def test_rejects_equals_form_on_boolean_flags() -> None:
    with pytest.raises(UnknownFlagError):
        parse_flags(["--json=true"], DEFS)


def test_define_flags_returns_input_identity() -> None:
    typed_defs = define_flags(
        [
            {"name": "--out", "type": "string", "description": "Output"},
            {"name": "--verbose", "type": "boolean", "description": "Verbose"},
            {"name": "--tags", "type": "string[]", "description": "Tags"},
        ]
    )

    result = parse_flags(["--out", "file.ts", "--verbose", "--tags", "a,b"], typed_defs)

    assert result["--out"] == "file.ts"
    assert result["--verbose"] is True
    assert result["--tags"] == ["a", "b"]
