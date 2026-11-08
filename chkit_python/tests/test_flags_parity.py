"""1:1 port of ``packages/core/src/flags.test.ts``."""

from __future__ import annotations

import pytest

from chkit.core.flags import (
    FlagDef,
    MissingFlagValueError,
    UnknownFlagError,
    define_flags,
    expand_short_flags,
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


def test_throws_unknown_flag_error_for_short_flags() -> None:
    for argv, flag in [
        (["-t", "alpha", "--dryrun"], "-t"),
        (["--dryrun", "-c", "x.ts"], "-c"),
        (["-t=alpha"], "-t"),
        (["-5"], "-5"),
        (["-v"], "-v"),
    ]:
        with pytest.raises(UnknownFlagError, match=f"^Unknown flag: {flag}$"):
            parse_flags(argv, DEFS)


def test_keeps_values_that_start_with_a_dash_and_a_bare_dash() -> None:
    assert parse_flags(["--name", "-5"], DEFS)["--name"] == "-5"
    assert parse_flags(["--name", "-t"], DEFS)["--name"] == "-t"
    assert parse_flags(["--database", "-1,-2"], DEFS)["--database"] == ["-1", "-2"]
    assert parse_flags(["--name=-x"], DEFS)["--name"] == "-x"
    assert parse_flags(["-", "--dryrun"], DEFS)["--dryrun"] is True


SHORT_DEFS: list[FlagDef] = [
    {"name": "--table", "short": "-t", "type": "string", "description": "Table"},
    {"name": "--database", "short": "-d", "type": "string[]", "description": "Databases"},
    {"name": "--force", "short": "-f", "type": "boolean", "description": "Force"},
    {"name": "--yes", "short": "-y", "type": "boolean", "description": "Yes"},
    {"name": "--name", "type": "string", "description": "Name"},
]


def test_short_flags_parse_every_form_the_long_flag_accepts() -> None:
    assert parse_flags(["-t", "users"], SHORT_DEFS) == {"--table": "users"}
    assert parse_flags(["-t=users"], SHORT_DEFS) == {"--table": "users"}
    assert parse_flags(["-tusers"], SHORT_DEFS) == {"--table": "users"}
    assert parse_flags(["-d", "a,b", "-d=c"], SHORT_DEFS) == {"--database": ["a", "b", "c"]}
    assert parse_flags(["-f", "--name", "x"], SHORT_DEFS) == {"--force": True, "--name": "x"}


def test_short_flags_reject_a_bundle_as_one_unknown_flag() -> None:
    for argv, flag in [(["-fy"], "-fy"), (["-ft", "users"], "-ft"), (["-ft=users"], "-ft")]:
        with pytest.raises(UnknownFlagError, match=f"^Unknown flag: {flag}$"):
            parse_flags(argv, SHORT_DEFS)


def test_short_flags_keep_a_value_that_looks_like_a_short_flag() -> None:
    assert parse_flags(["--name", "-t"], SHORT_DEFS) == {"--name": "-t"}
    assert parse_flags(["-t", "-f"], SHORT_DEFS) == {"--table": "-f"}
    assert parse_flags(["--name=-t", "-f"], SHORT_DEFS) == {"--name": "-t", "--force": True}


def test_short_flags_reject_unknown_shorts_boolean_values_and_missing_values() -> None:
    with pytest.raises(UnknownFlagError, match=r"^Unknown flag: -x$"):
        parse_flags(["-x"], SHORT_DEFS)
    with pytest.raises(UnknownFlagError, match=r"^Unknown flag: -fx$"):
        parse_flags(["-fx"], SHORT_DEFS)
    with pytest.raises(UnknownFlagError):
        parse_flags(["-f=1"], SHORT_DEFS)
    with pytest.raises(MissingFlagValueError, match=r"^Missing value for --table$"):
        parse_flags(["-t"], SHORT_DEFS)
    with pytest.raises(MissingFlagValueError, match=r"^Missing value for --table$"):
        parse_flags(["-t", "--force"], SHORT_DEFS)


def test_expand_short_flags_rewrites_known_shorts_and_leaves_everything_else() -> None:
    assert expand_short_flags(
        ["status", "-t", "u", "-x", "-", "--name", "-f", "-f"], SHORT_DEFS
    ) == ["status", "--table", "u", "-x", "-", "--name", "-f", "--force"]
    assert expand_short_flags(["-t=u", "-fy", "-ta=b", "--", "-f"], SHORT_DEFS) == [
        "--table=u",
        "-fy",
        "--table=a=b",
        "--",
        "-f",
    ]


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
