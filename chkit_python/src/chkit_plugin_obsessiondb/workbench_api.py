"""Workbench oRPC client — proxy SQL through the ObsessionDB API.

1:1 port of ``packages/plugin-obsessiondb/src/contract/workbench.ts``.

The contract is one endpoint, ``workbench.query.execute``, which accepts a
service slug + raw SQL and returns ClickHouse JSON-style result rows. The
remote executor in :mod:`remote_executor` wraps this into the same surface
the local ``ClickHouseClient`` exposes so the rest of the CLI doesn't have
to know whether it's hitting a managed cloud instance or a local Docker.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict

from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.service_api import _rpc_post


class WorkbenchColumn(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    name: str
    type: str


class WorkbenchExecuteResult(BaseModel):
    """Mirrors the TS ``ClickHouseJsonQueryResult`` returned by the endpoint."""

    model_config = ConfigDict(frozen=True, extra="ignore")

    data: list[Any]
    meta: list[WorkbenchColumn]
    rows: int
    statistics: dict[str, Any] | None = None
    query_id: str | None = None
    error: str | None = None


def workbench_query_execute(
    creds: Credentials,
    *,
    service_slug: str,
    query: str,
    settings: dict[str, Any] | None = None,
) -> WorkbenchExecuteResult:
    """``workbench.query.execute`` — proxy a SQL string through ObsessionDB."""
    payload: dict[str, Any] = {"serviceSlug": service_slug, "query": query}
    if settings is not None:
        payload["settings"] = settings
    body = _rpc_post(creds, "workbench/query/execute", payload)
    return WorkbenchExecuteResult.model_validate(body)
