"""Base model for ObsessionDB console API payloads.

The console API (its oRPC contracts and better-auth) speaks camelCase
(``createdAt``, ``activeOrganizationId``, ...). Models keep snake_case
attributes and read and write the camelCase names through generated aliases;
``populate_by_name`` still lets code and tests build them by attribute name.
Dump with ``by_alias=True`` to reproduce the wire (and the TS client's) shape.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class ConsoleApiModel(BaseModel):
    model_config = ConfigDict(
        frozen=True,
        extra="ignore",
        alias_generator=to_camel,
        populate_by_name=True,
    )


__all__ = ["ConsoleApiModel"]
