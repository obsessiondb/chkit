"""JSON output envelope + double-emit guard for ``--json`` mode.

1:1 port of ``packages/cli/src/runtime/json-output.ts``.

Every successful payload is wrapped as ``{schemaVersion, command, ...payload}``
so consumers can keep parsing across chkit versions. Errors get a separate
``{command, schemaVersion, ok: false, error: {...}}`` envelope so a thrown
exception still leaves stdout a valid JSON object — without this, a pipe to
``jq`` would crash on first failure.

The module also tracks a process-level "emitted" flag so a command that
already wrote JSON doesn't accidentally double-emit when an outer handler
also tries to wrap the same error.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Literal, TypedDict

JSON_CONTRACT_VERSION = 1

Command = Literal[
    "generate",
    "migrate",
    "status",
    "drift",
    "check",
    "plugin",
    "query",
    "pull",
]


_emitted = False


def has_emitted_json() -> bool:
    """True once any JSON payload (success or error) has been written to stdout."""
    return _emitted


def _reset_for_testing() -> None:
    """Reset the module-level emit flag. Used only by tests."""
    global _emitted  # noqa: PLW0603
    _emitted = False


def print_output(value: Any, *, json_mode: bool) -> None:
    """Emit ``value`` to stdout, wrapping bare strings under ``--json``."""
    global _emitted  # noqa: PLW0603
    if json_mode:
        _emitted = True
        payload: Any = (
            {"schemaVersion": JSON_CONTRACT_VERSION, "message": value}
            if isinstance(value, str)
            else value
        )
        print(json.dumps(payload, indent=2, default=str), file=sys.stdout)
        return
    if isinstance(value, str):
        print(value, file=sys.stdout)


def emit_json(command: Command, payload: dict[str, Any]) -> None:
    """Write a wrapped success payload: ``{command, schemaVersion, ...payload}``."""
    wrapped = {"command": command, "schemaVersion": JSON_CONTRACT_VERSION, **payload}
    print_output(wrapped, json_mode=True)


class JsonError(TypedDict, total=False):
    code: str
    message: str
    hint: str


class JsonErrorEnvelope(TypedDict):
    command: str
    schemaVersion: int
    ok: Literal[False]
    error: JsonError


def build_json_error_envelope(command: str, error: JsonError) -> JsonErrorEnvelope:
    return JsonErrorEnvelope(
        command=command,
        schemaVersion=JSON_CONTRACT_VERSION,
        ok=False,
        error=error,
    )


def emit_json_error(command: str, error: JsonError) -> None:
    """Emit a stable error envelope so ``--json`` consumers can still parse."""
    global _emitted  # noqa: PLW0603
    _emitted = True
    envelope = build_json_error_envelope(command, error)
    print(json.dumps(envelope, indent=2, default=str), file=sys.stdout)
