"""ObsessionDB service / jobs / workbench oRPC client.

Wire protocol (mirrors ``@orpc/client/fetch``'s ``RPCLink``):

    POST ``{base_url}/rpc/{procedure_path}`` with the input as JSON body

The token is sent as ``Authorization: Bearer <token>``. HTTP 401 returns are
translated into ``SessionExpiredError`` so callers can route to a re-login.

Subset of the TS contracts ported here:

- ``services.listAll`` → :class:`ListAllResponse`
- ``services.get`` → :class:`Service`
- ``services.instanceClaimStatus`` → :class:`InstanceClaimStatus`
- ``services.claimInstance`` → :class:`ClaimInstanceResult`
"""

from __future__ import annotations

from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict

from chkit_plugin_obsessiondb.api_client import (
    USER_AGENT,
    SessionExpiredError,
    SessionResponse,
)
from chkit_plugin_obsessiondb.credentials import Credentials

ServiceStatus = Literal[
    "provisioning",
    "running",
    "scaling",
    "stopping",
    "stopped",
    "starting",
    "terminating",
    "terminated",
    "error",
]
ClaimOutcome = Literal["claimed", "none_available", "already_claimed"]
DesiredStatus = Literal["running", "stopped", "terminated"]


class Service(BaseModel):
    """One service row as returned by ``services.get`` / ``services.listAll``."""

    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)

    id: str
    slug: str
    name: str
    status: ServiceStatus
    tier: int
    nodes: int
    connection_url: str | None = None
    connection_username: str | None = None
    desired_status: DesiredStatus
    desired_tier: int
    desired_nodes: int
    created_at: str
    managed: bool


class ServiceOrganization(BaseModel):
    """An organization with the services it owns."""

    model_config = ConfigDict(frozen=True, extra="ignore")

    id: str
    name: str
    slug: str
    services: list[Service]


class ListAllResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    organizations: list[ServiceOrganization]


class InstanceClaimStatusEligible(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    eligible: Literal[True] = True


class InstanceClaimStatusIneligible(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)

    eligible: Literal[False] = False
    claimed_organization_name: str


InstanceClaimStatus = InstanceClaimStatusEligible | InstanceClaimStatusIneligible


class ClaimInstanceClaimed(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    outcome: Literal["claimed"] = "claimed"
    id: str
    slug: str


class ClaimInstanceNoneAvailable(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    outcome: Literal["none_available"] = "none_available"


class ClaimInstanceAlreadyClaimed(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)

    outcome: Literal["already_claimed"] = "already_claimed"
    claimed_organization_name: str


ClaimInstanceResult = (
    ClaimInstanceClaimed | ClaimInstanceNoneAvailable | ClaimInstanceAlreadyClaimed
)

HTTP_TIMEOUT_SECONDS = 30.0
HTTP_401_UNAUTHORIZED = 401


def _rpc_post(creds: Credentials, procedure: str, payload: Any) -> Any:
    """POST to ``{base_url}/rpc/{procedure}`` with bearer auth + ``{input: ...}`` body.

    Translates HTTP 401 into ``SessionExpiredError`` so callers handle session
    expiry uniformly. Non-2xx for any other code raises ``RuntimeError`` with
    the response body for debugging.
    """
    url = f"{creds.base_url}/rpc/{procedure}"
    body = {"input": payload}
    headers = {
        "Authorization": f"Bearer {creds.access_token}",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }
    with httpx.Client(timeout=HTTP_TIMEOUT_SECONDS) as http:
        res = http.post(url, json=body, headers=headers)
    if res.status_code == HTTP_401_UNAUTHORIZED:
        raise SessionExpiredError
    if res.status_code >= httpx.codes.BAD_REQUEST:
        msg = f"RPC {procedure} failed: {res.status_code} {res.text}"
        raise RuntimeError(msg)
    try:
        return res.json()
    except ValueError:
        msg = f"RPC {procedure} returned non-JSON body: {res.text[:200]}"
        raise RuntimeError(msg)  # noqa: B904


def list_service_organizations(creds: Credentials) -> list[ServiceOrganization]:
    """``services.listAll`` → all organisations + services visible to the session."""
    body = _rpc_post(creds, "services/listAll", {})
    parsed = ListAllResponse.model_validate(body)
    return parsed.organizations


def list_services(creds: Credentials) -> list[Service]:
    """Flatten ``listAll`` into a single ``Service`` list."""
    orgs = list_service_organizations(creds)
    return [service for org in orgs for service in org.services]


def get_service(creds: Credentials, *, service_slug: str) -> Service:
    """``services.get`` → one service by slug."""
    body = _rpc_post(creds, "services/get", {"serviceSlug": service_slug})
    return Service.model_validate(body)


def instance_claim_status(creds: Credentials) -> InstanceClaimStatus:
    """``services.instanceClaimStatus`` → "eligible" or "already claimed"."""
    body = _rpc_post(creds, "services/instanceClaimStatus", {})
    if body.get("eligible") is True:
        return InstanceClaimStatusEligible()
    return InstanceClaimStatusIneligible.model_validate(body)


def claim_instance(
    creds: Credentials, *, organization_id: str | None = None
) -> ClaimInstanceResult:
    """``services.claimInstance`` → claimed / none_available / already_claimed."""
    payload: dict[str, str] = {}
    if organization_id is not None:
        payload["organizationId"] = organization_id
    body = _rpc_post(creds, "services/claimInstance", payload)
    outcome = body.get("outcome")
    if outcome == "claimed":
        return ClaimInstanceClaimed.model_validate(body)
    if outcome == "none_available":
        return ClaimInstanceNoneAvailable()
    if outcome == "already_claimed":
        return ClaimInstanceAlreadyClaimed.model_validate(body)
    msg = f"Unexpected claim outcome: {outcome!r}"
    raise RuntimeError(msg)


__all__ = [
    "ClaimInstanceAlreadyClaimed",
    "ClaimInstanceClaimed",
    "ClaimInstanceNoneAvailable",
    "ClaimInstanceResult",
    "InstanceClaimStatus",
    "InstanceClaimStatusEligible",
    "InstanceClaimStatusIneligible",
    "ListAllResponse",
    "Service",
    "ServiceOrganization",
    "ServiceStatus",
    "SessionResponse",
    "claim_instance",
    "get_service",
    "instance_claim_status",
    "list_service_organizations",
    "list_services",
]
