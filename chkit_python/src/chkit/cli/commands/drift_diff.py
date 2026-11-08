"""SQL fragment / named-shape diffing helpers used by drift compare.

1:1 port of ``packages/cli/src/commands/drift/diff.ts``.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TypeVar

from chkit.core.table_settings import setting_value_fingerprint

_T = TypeVar("_T")


@dataclass(frozen=True, slots=True)
class DiffByNameResult:
    missing: list[str]
    extra: list[str]
    changed: list[str]


def diff_by_name(
    expected_items: Sequence[_T],
    actual_items: Sequence[_T],
    get_name: Callable[[_T], str],
    get_shape: Callable[[_T], str],
) -> DiffByNameResult:
    """Bucket items into missing / extra / changed by name + shape fingerprint."""
    expected = {get_name(item): get_shape(item) for item in expected_items}
    actual = {get_name(item): get_shape(item) for item in actual_items}
    missing: list[str] = []
    extra: list[str] = []
    changed: list[str] = []

    for name, expected_shape in expected.items():
        actual_shape = actual.get(name)
        if actual_shape is None:
            missing.append(name)
            continue
        if actual_shape != expected_shape:
            changed.append(name)

    extra = [name for name in actual if name not in expected]

    return DiffByNameResult(missing=missing, extra=extra, changed=changed)


def diff_settings(
    expected_settings: Mapping[str, str | int | float | bool],
    actual_settings: Mapping[str, str | int | float | bool],
) -> list[str]:
    """Return keys whose value differs between expected and actual, compared by
    ``setting_value_fingerprint`` (``8192`` and ``"8192"``, ``2.0`` and ``2.``)."""
    diffs: list[str] = []
    for key in sorted(expected_settings):
        left = setting_value_fingerprint(expected_settings[key])
        right = setting_value_fingerprint(actual_settings[key]) if key in actual_settings else ""
        if left != right:
            diffs.append(key)
    return diffs


def diff_named_shape_maps(
    expected: Mapping[str, str],
    actual: Mapping[str, str],
) -> list[str]:
    """Return keys whose normalized shape strings differ between the two maps."""
    keys = sorted(set(expected) | set(actual))
    return [key for key in keys if expected.get(key, "") != actual.get(key, "")]
