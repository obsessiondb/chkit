"""Public types for the codegen plugin (findings, name resolution)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, TypeAlias

from chkit.core import SchemaDefinition

CodegenFindingCode: TypeAlias = Literal[
    "codegen_unsupported_type",
    "codegen_stale_output",
    "codegen_missing_output",
]

CodegenFindingSeverity: TypeAlias = Literal["warn", "error", "info"]


@dataclass(frozen=True, slots=True)
class CodegenFinding:
    code: CodegenFindingCode
    message: str
    severity: CodegenFindingSeverity
    path: str | None = None


@dataclass(frozen=True, slots=True)
class ResolvedTableName:
    """Pairs a schema definition with its emitted Python class name."""

    definition: SchemaDefinition
    class_name: str


@dataclass(frozen=True, slots=True)
class CodegenCheckResult:
    plugin: str = "codegen"
    evaluated: bool = True
    ok: bool = True
    findings: list[CodegenFinding] = field(default_factory=list)
    metadata: dict[str, object] = field(default_factory=dict)


__all__ = [
    "CodegenCheckResult",
    "CodegenFinding",
    "CodegenFindingCode",
    "CodegenFindingSeverity",
    "ResolvedTableName",
]
