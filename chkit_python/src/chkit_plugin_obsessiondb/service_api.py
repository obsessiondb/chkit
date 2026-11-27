"""ObsessionDB service / jobs / workbench oRPC client.

Wire protocol (mirrors ``@orpc/client/fetch``'s ``RPCLink``):

    POST ``{base_url}/rpc/{procedure_path}`` with the input as JSON body

The token is sent as ``Authorization: Bearer <token>``. HTTP 401 returns are
translated into ``SessionExpiredError`` so callers can route to a re-login.
Any other failure raises what TS's ``RPCLink`` throws: a
:class:`ConsoleApiError` with the oRPC error's message and code, or a
``RuntimeError`` for a body it cannot parse and for a network failure. A
``NOT_FOUND`` for a call with a ``serviceSlug`` raises ``ServiceNotFoundError``
when the service is in another organization than the session's active one, or
in none.

Subset of the TS contracts ported here:

- ``services.listAll`` → :class:`ListAllResponse`
- ``services.get`` → :class:`Service`
- ``services.instanceClaimStatus`` → :class:`InstanceClaimStatus`
- ``services.claimInstance`` → :class:`ClaimInstanceResult`
"""

from __future__ import annotations

import json
from typing import Any, Literal

import httpcore
import httpx

from chkit.clickhouse.client import (
    SUBMIT_WRITE_TIMEOUT_SECONDS,
    guard_begin_write,
    guard_end_write,
)
from chkit_plugin_obsessiondb.api_client import (
    USER_AGENT,
    SessionExpiredError,
    SessionResponse,
    get_session,
)
from chkit_plugin_obsessiondb.api_model import ConsoleApiModel
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.orpc_rpc_json import (
    UNDEFINED,
    InvalidRpcFormatError,
    deserialize_rpc_body,
)

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


class Service(ConsoleApiModel):
    """One service row as returned by ``services.get`` / ``services.listAll``."""

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


class ServiceOrganization(ConsoleApiModel):
    """An organization with the services it owns."""

    id: str
    name: str
    slug: str
    services: list[Service]


class ListAllResponse(ConsoleApiModel):
    organizations: list[ServiceOrganization]


class InstanceClaimStatusEligible(ConsoleApiModel):
    eligible: Literal[True] = True


class InstanceClaimStatusIneligible(ConsoleApiModel):
    eligible: Literal[False] = False
    claimed_organization_name: str


InstanceClaimStatus = InstanceClaimStatusEligible | InstanceClaimStatusIneligible


class ClaimInstanceClaimed(ConsoleApiModel):
    outcome: Literal["claimed"] = "claimed"
    id: str
    slug: str


class ClaimInstanceNoneAvailable(ConsoleApiModel):
    outcome: Literal["none_available"] = "none_available"


class ClaimInstanceAlreadyClaimed(ConsoleApiModel):
    outcome: Literal["already_claimed"] = "already_claimed"
    claimed_organization_name: str


ClaimInstanceResult = (
    ClaimInstanceClaimed | ClaimInstanceNoneAvailable | ClaimInstanceAlreadyClaimed
)

HTTP_TIMEOUT_SECONDS = 30.0
HTTP_401_UNAUTHORIZED = 401

ServiceNotFoundCode = Literal["service_not_in_active_organization", "service_not_found"]


class ServiceNotFoundError(RuntimeError):
    """A console call for a service failed because the console could not find it.

    ``code`` is the stable ``--json`` error code, as in the TS client.
    """

    def __init__(
        self, message: str, *, code: ServiceNotFoundCode = "service_not_found"
    ) -> None:
        super().__init__(message)
        self.code: ServiceNotFoundCode = code


def _rpc_post(
    creds: Credentials,
    procedure: str,
    payload: Any,
    *,
    timeout: httpx.Timeout | float = HTTP_TIMEOUT_SECONDS,
    guard: Any = None,
) -> Any:
    """POST to ``{base_url}/rpc/{procedure}`` with bearer auth, oRPC RPC envelope.

    ``guard``, a submit's guard, holds the request's write once the
    connection is open (see ``guard_begin_write``); when it refuses, nothing
    is sent (#767). The connection is the client's own, so no earlier request
    shares it.

    The oRPC RPC protocol (what TS's ``RPCLink`` speaks) wraps the input as
    ``{"json": ...}`` and the output the same way; the API rejects any other
    body with ``400 Input validation failed``. Translates HTTP 401 into
    ``SessionExpiredError`` so callers handle session expiry uniformly. Any
    other failure raises the error TS's ``RPCLink`` throws, with its message:
    see :func:`_decode_body` and :func:`_orpc_error`.
    """
    url = f"{creds.base_url}/rpc/{procedure}"
    body = {"json": payload}
    headers = {
        "Authorization": f"Bearer {creds.access_token}",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }
    with httpx.Client(timeout=timeout) as http:
        if guard is not None:
            _guard_first_write(http, guard)
        request = http.build_request("POST", url, json=body, headers=headers)
        # Like ``fetch``, the request ends with the response headers; the body
        # is read after, and a failure to read it reads as a parse failure.
        try:
            res = http.send(request, stream=True)
        except httpx.TransportError as error:
            # Node's fetch rejects every network failure with this message.
            raise RuntimeError(_NETWORK_ERROR) from error
        try:
            if res.status_code == HTTP_401_UNAUTHORIZED:
                raise SessionExpiredError
            try:
                res.read()
            except httpx.TransportError as error:
                raise RuntimeError(_UNPARSABLE_BODY_ERROR) from error
        finally:
            res.close()
    # RPCLink decodes the body before it looks at the status.
    envelope, decoded = _decode_body(res)
    if res.status_code >= httpx.codes.BAD_REQUEST:
        orpc_error = _orpc_error(res.status_code, decoded)
        service_slug = payload.get("serviceSlug") if isinstance(payload, dict) else None
        if orpc_error.code == "NOT_FOUND" and isinstance(service_slug, str):
            # Every call for a service (workbench queries, job submit and list)
            # passes here, so query, migrate and backfill all get the explanation.
            explained = explain_service_not_found(creds, service_slug)
            if explained is not None:
                raise explained
        raise orpc_error
    if envelope is UNDEFINED:
        # A body RPCLink does not parse as JSON (another content type, or empty).
        try:
            envelope = res.json()
        except ValueError:
            raise RuntimeError(_UNPARSABLE_BODY_ERROR) from None
    return envelope["json"] if isinstance(envelope, dict) and "json" in envelope else envelope


def _guard_first_write(http: httpx.Client, guard: Any) -> None:
    """Run the first write on any connection ``http`` opens under ``guard``.

    Every transport of the client, an environment proxy's included, connects
    through the guarded backend.
    """
    transports = [http._transport, *http._mounts.values()]
    for transport in transports:
        pool = getattr(transport, "_pool", None)
        if pool is not None:
            pool._network_backend = _GuardedBackend(pool._network_backend, guard)


class _GuardedBackend(httpcore.NetworkBackend):
    def __init__(self, inner: httpcore.NetworkBackend, guard: Any) -> None:
        self._inner = inner
        self._guard = guard

    def connect_tcp(self, *args: Any, **kwargs: Any) -> httpcore.NetworkStream:
        return _GuardedStream(self._inner.connect_tcp(*args, **kwargs), self._guard)

    def connect_unix_socket(self, *args: Any, **kwargs: Any) -> httpcore.NetworkStream:
        return _GuardedStream(self._inner.connect_unix_socket(*args, **kwargs), self._guard)

    def sleep(self, seconds: float) -> None:
        self._inner.sleep(seconds)


class _GuardedStream(httpcore.NetworkStream):
    """Writes a request under the submit's guard (#767).

    The first write of the origin request starts the guarded write, and the
    request is written once the stream is first read (the response) or
    closed. Its writes run under the submit's write timeout. A proxy's
    ``CONNECT`` and the TLS handshake through its tunnel are connection setup:
    the guard stays armed through them, and is carried into the TLS stream.
    """

    def __init__(self, inner: httpcore.NetworkStream, guard: Any) -> None:
        self._inner = inner
        self._guard = guard
        self._writing: Any = None
        # A stream that carried a proxy's CONNECT is the tunnel: the origin
        # request goes through the TLS stream ``start_tls`` opens on it.
        self._tunnel = False

    def _end_write(self) -> None:
        writing, self._writing = self._writing, None
        if writing is not None:
            guard_end_write(writing)

    def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        # A read ends the request's write (its response follows), not the
        # proxy's CONNECT, whose guard is still armed.
        self._end_write()
        return self._inner.read(max_bytes, timeout)

    def write(self, buffer: bytes, timeout: float | None = None) -> None:
        if buffer.startswith(b"CONNECT "):
            self._tunnel = True
        if self._guard is not None and not self._tunnel and buffer:
            guard, self._guard = self._guard, None
            try:
                guard_begin_write(guard)
            except BaseException:
                self._inner.close()
                raise
            self._writing = guard
        if self._writing is not None:
            timeout = min(timeout or SUBMIT_WRITE_TIMEOUT_SECONDS, SUBMIT_WRITE_TIMEOUT_SECONDS)
        try:
            self._inner.write(buffer, timeout)
        except BaseException:
            self._end_write()
            raise

    def close(self) -> None:
        self._end_write()
        self._inner.close()

    def start_tls(self, *args: Any, **kwargs: Any) -> httpcore.NetworkStream:
        # The handshake is connection setup; the request's bytes follow it.
        return _GuardedStream(self._inner.start_tls(*args, **kwargs), self._guard)

    def get_extra_info(self, info: str) -> Any:
        return self._inner.get_extra_info(info)


class ConsoleApiError(RuntimeError):
    """An error response of the console API, as TS's ``ORPCError``.

    ``code`` is the oRPC error code (e.g. ``INTERNAL_SERVER_ERROR``), which is
    also the ``--json`` error code, as in TS.
    """

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


# The messages and codes of ``@orpc/client`` 1.15.4, the version the TS plugin uses.
_NETWORK_ERROR = "fetch failed"
_UNPARSABLE_BODY_ERROR = (
    "Cannot parse response body, please check the response body and content-type."
)
_INVALID_FORMAT_ERROR = "Invalid RPC response format."
_MALFORMED_ERROR_CODE = "MALFORMED_ORPC_ERROR_RESPONSE"
# ``COMMON_ORPC_ERROR_DEFS``: code -> (HTTP status, default message).
_COMMON_ORPC_ERRORS: dict[str, tuple[int, str]] = {
    "BAD_REQUEST": (400, "Bad Request"),
    "UNAUTHORIZED": (401, "Unauthorized"),
    "FORBIDDEN": (403, "Forbidden"),
    "NOT_FOUND": (404, "Not Found"),
    "METHOD_NOT_SUPPORTED": (405, "Method Not Supported"),
    "NOT_ACCEPTABLE": (406, "Not Acceptable"),
    "TIMEOUT": (408, "Request Timeout"),
    "CONFLICT": (409, "Conflict"),
    "PRECONDITION_FAILED": (412, "Precondition Failed"),
    "PAYLOAD_TOO_LARGE": (413, "Payload Too Large"),
    "UNSUPPORTED_MEDIA_TYPE": (415, "Unsupported Media Type"),
    "UNPROCESSABLE_CONTENT": (422, "Unprocessable Content"),
    "TOO_MANY_REQUESTS": (429, "Too Many Requests"),
    "CLIENT_CLOSED_REQUEST": (499, "Client Closed Request"),
    "INTERNAL_SERVER_ERROR": (500, "Internal Server Error"),
    "NOT_IMPLEMENTED": (501, "Not Implemented"),
    "BAD_GATEWAY": (502, "Bad Gateway"),
    "SERVICE_UNAVAILABLE": (503, "Service Unavailable"),
    "GATEWAY_TIMEOUT": (504, "Gateway Timeout"),
}
_ORPC_ERROR_KEYS = frozenset({"defined", "code", "status", "message", "data"})


def _decode_body(res: httpx.Response) -> tuple[Any, Any]:
    """The parsed body of a response, and the value ``RPCLink`` decodes from it.

    Mirrors ``toStandardBody`` (``@orpc/standard-server-fetch``) and
    ``StandardRPCSerializer.deserialize``: only a body without a content type
    or with an ``application/json`` one is parsed (else both are
    ``UNDEFINED``), and the value is the envelope's ``json`` after its
    ``meta``. Raises the ``RuntimeError`` ``RPCLink`` throws for a body it
    cannot parse or decode.
    """
    if "content-disposition" in res.headers:
        return UNDEFINED, UNDEFINED
    content_type = res.headers.get("content-type")
    if content_type and not content_type.startswith("application/json"):
        return UNDEFINED, UNDEFINED
    # Like ``Response.text()``: UTF-8 whatever the charset, without a BOM.
    text = res.content.decode("utf-8", errors="replace").removeprefix(chr(0xFEFF))
    if not text:
        return UNDEFINED, UNDEFINED
    try:
        value = json.loads(text, parse_constant=_reject_json_constant)
    except ValueError:
        raise RuntimeError(_UNPARSABLE_BODY_ERROR) from None
    try:
        return value, deserialize_rpc_body(value)
    except InvalidRpcFormatError:
        raise RuntimeError(_INVALID_FORMAT_ERROR) from None


def _reject_json_constant(constant: str) -> Any:
    # ``JSON.parse`` rejects NaN and Infinity, which ``json.loads`` accepts.
    msg = f"invalid JSON constant {constant}"
    raise ValueError(msg)


def _orpc_error(status: int, decoded: Any) -> ConsoleApiError:
    """The ``ORPCError`` ``RPCLink`` throws for an error response.

    An oRPC error body gives its code and its message, or the code's default
    message when that is empty. Any other body gives the code of the HTTP
    status and its default message, or ``MALFORMED_ORPC_ERROR_RESPONSE``.
    """
    if _is_orpc_error_json(decoded):
        return ConsoleApiError(
            _orpc_error_message(decoded["code"], decoded["message"]), code=decoded["code"]
        )
    code = next(
        (name for name, (code_status, _) in _COMMON_ORPC_ERRORS.items() if code_status == status),
        _MALFORMED_ERROR_CODE,
    )
    return ConsoleApiError(_orpc_error_message(code, ""), code=code)


def _orpc_error_message(code: str, message: str) -> str:
    if message:
        return message
    common = _COMMON_ORPC_ERRORS.get(code)
    return common[1] if common else code


def _is_orpc_error_json(value: Any) -> bool:
    """``isORPCErrorJson``: exactly the fields of a serialized ``ORPCError``."""
    if not isinstance(value, dict) or not set(value) <= _ORPC_ERROR_KEYS:
        return False
    status = value.get("status")
    return (
        isinstance(value.get("defined"), bool)
        and isinstance(value.get("code"), str)
        and isinstance(status, int | float)
        and not isinstance(status, bool)
        and (status < httpx.codes.OK or status >= httpx.codes.BAD_REQUEST)
        and isinstance(value.get("message"), str)
    )


def explain_service_not_found(
    creds: Credentials, service_slug: str
) -> ServiceNotFoundError | None:
    """Explain a 404 for ``service_slug``, or ``None`` when the lookup cannot.

    The console looks a service slug up in the session's active organization
    only, so a call for a service of another organization fails with a bare
    404. Mirrors ``explainServiceNotFound`` in the TS plugin.
    """
    try:
        organizations = list_service_organizations(creds)
        session = get_session(creds.base_url, creds.access_token).session
    except Exception:
        # The original 404 is more useful than a failure of the lookup.
        return None
    active_organization_id = session.active_organization_id if session else None

    owners = [
        org
        for org in organizations
        if any(service.slug == service_slug for service in org.services)
    ]
    if not owners:
        return ServiceNotFoundError(
            f'obsessiondb: service "{service_slug}" was not found in any '
            "organization you can access. It may have been deleted, or you may "
            "no longer have access to it. Select another service with "
            "`chkit obsessiondb service select`.",
            code="service_not_found",
        )

    # Without an active organization the console searches every organization;
    # with the service in the active one, the 404 has another cause.
    if not active_organization_id:
        return None
    if any(org.id == active_organization_id for org in owners):
        return None

    active = next(
        (org for org in organizations if org.id == active_organization_id), None
    )
    active_label = f'"{active.name if active else active_organization_id}"'
    owner_label = ", ".join(f'"{org.name}"' for org in owners)
    return ServiceNotFoundError(
        f'obsessiondb: service "{service_slug}" is not in the active organization '
        f"{active_label} of this chkit session (it belongs to {owner_label}). "
        "The ObsessionDB console only finds services in the session's active "
        "organization, and switching organizations in the console does not "
        "change the chkit session's. Select a service from "
        f"{active_label} with `chkit obsessiondb service select`.",
        code="service_not_in_active_organization",
    )


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
    "ConsoleApiError",
    "InstanceClaimStatus",
    "InstanceClaimStatusEligible",
    "InstanceClaimStatusIneligible",
    "ListAllResponse",
    "Service",
    "ServiceNotFoundError",
    "ServiceOrganization",
    "ServiceStatus",
    "SessionResponse",
    "claim_instance",
    "explain_service_not_found",
    "get_service",
    "instance_claim_status",
    "list_service_organizations",
    "list_services",
]
