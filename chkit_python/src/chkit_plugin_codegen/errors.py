"""Custom errors emitted by the codegen plugin."""

from __future__ import annotations


class CodegenError(Exception):
    """Base class for all codegen plugin errors."""


class CodegenConfigError(CodegenError):
    """Raised when codegen plugin options can't be parsed."""


class UnsupportedTypeError(CodegenError):
    """Raised when a ClickHouse column type can't be mapped to a Python type.

    Only thrown when ``fail_on_unsupported_type=True`` (the default). With
    ``fail_on_unsupported_type=False`` the generator emits ``Any`` and adds a
    finding instead.
    """

    def __init__(self, path: str, type_str: str) -> None:
        super().__init__(
            f'Unsupported ClickHouse type "{type_str}" at {path}; '
            "set `failOnUnsupportedType: False` to emit `Any` instead."
        )
        self.path = path
        self.type_str = type_str


__all__ = [
    "CodegenConfigError",
    "CodegenError",
    "UnsupportedTypeError",
]
