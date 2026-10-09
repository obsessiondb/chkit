"""Generic diff helpers used by the migration planner."""

from __future__ import annotations

from collections.abc import Callable
from typing import Generic, Literal, TypeAlias, TypeVar

from pydantic import BaseModel, ConfigDict

_T = TypeVar("_T")


class NamedDiffChange(BaseModel, Generic[_T]):
    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    name: str
    old_item: _T
    new_item: _T


class NamedDiffResult(BaseModel, Generic[_T]):
    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    added: list[_T]
    removed: list[_T]
    changed: list[NamedDiffChange[_T]]


def diff_by_name(
    old_items: list[_T],
    new_items: list[_T],
    get_name: Callable[[_T], str],
    equals: Callable[[_T, _T], bool],
) -> NamedDiffResult[_T]:
    old_by_name: dict[str, _T] = {get_name(item): item for item in old_items}
    new_names = {get_name(item) for item in new_items}
    added: list[_T] = []
    changed: list[NamedDiffChange[_T]] = []
    removed: list[_T] = []

    for new_item in new_items:
        name = get_name(new_item)
        old_item = old_by_name.get(name)
        if old_item is None:
            added.append(new_item)
            continue
        if not equals(old_item, new_item):
            changed.append(NamedDiffChange(name=name, old_item=old_item, new_item=new_item))

    for old_item in old_items:
        name = get_name(old_item)
        if name not in new_names:
            removed.append(old_item)

    return NamedDiffResult(added=added, removed=removed, changed=changed)


SettingValue: TypeAlias = str | int | float | bool


class _SettingModify(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["modify"] = "modify"
    key: str
    value: SettingValue


class _SettingReset(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["reset"] = "reset"
    key: str


SettingChange: TypeAlias = _SettingModify | _SettingReset


class SettingDiffResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    changes: list[SettingChange]


def diff_settings(
    old_settings: dict[str, SettingValue],
    new_settings: dict[str, SettingValue],
) -> SettingDiffResult:
    keys = sorted(set(old_settings.keys()) | set(new_settings.keys()))
    changes: list[SettingChange] = []
    for key in keys:
        had = key in old_settings
        if key not in new_settings:
            if had:
                changes.append(_SettingReset(key=key))
            continue
        next_value = new_settings[key]
        if not had or old_settings[key] != next_value:
            changes.append(_SettingModify(key=key, value=next_value))
    return SettingDiffResult(changes=changes)


def diff_clauses(comparisons: list[tuple[str, str]]) -> bool:
    return any(old != new for (old, new) in comparisons)
