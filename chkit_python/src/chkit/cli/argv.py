"""Port of ``packages/cli/src/runtime/argv.ts``: global flags before the command (#597)."""

from __future__ import annotations

from chkit.core.flags import FlagDef, MissingFlagValueError, expand_short_flags

# The TS GLOBAL_FLAGS plus TABLE_FLAG (packages/cli/src/runtime/global-flags.ts):
# `--table` may lead too; the command then accepts or rejects it (#565).
_LEADING_FLAGS: list[FlagDef] = [
    {"name": "--help-plugins", "type": "boolean"},
    {"name": "--config", "short": "-c", "type": "string"},
    {"name": "--json", "type": "boolean"},
    {"name": "--table", "short": "-t", "type": "string"},
]


def normalize_global_args(argv: list[str]) -> list[str]:
    """Move leading global options behind the command without consuming command arguments.

    The first other token is the command, whatever it is. With only global
    options, the command is ``--help``. A leading value flag without its value
    (at the end, or followed by a ``--`` token) raises ``MissingFlagValueError``.
    """
    by_name = {flag["name"]: flag for flag in _LEADING_FLAGS}
    leading: list[str] = []
    index = 0
    while index < len(argv):
        # A leading `-c x` reads as `--config x`; the global shorts all take a value,
        # so one token never expands to more than one flag.
        token = expand_short_flags([argv[index]], _LEADING_FLAGS)[0]
        name, equal, _value = token.partition("=")
        flag = by_name.get(name)
        if flag is None:
            break
        leading.append(token)
        index += 1
        if flag["type"] != "boolean" and not equal:
            if index >= len(argv) or argv[index].startswith("--"):
                raise MissingFlagValueError(name)
            leading.append(argv[index])
            index += 1
    if index == 0:
        return argv
    if index == len(argv):
        return ["--help", *leading]
    return [argv[index], *leading, *argv[index + 1 :]]
