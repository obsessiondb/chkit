"""Console API errors other than 401 read as in TS (#741).

The expected message and ``code`` of each case are what the TS plugin's
``createApiClient`` (``packages/plugin-obsessiondb/dist/client.js``, on
``@orpc/client`` 1.15.4 under Node 24) threw for the same response from a local
stub server: the ``message`` and ``code`` of the ``ORPCError``, or of the plain
``Error`` / ``TypeError`` (no code) for a body it cannot decode and a network
failure.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pytest_httpx import HTTPXMock

from chkit.cli.json_output import json_error_code
from chkit_plugin_obsessiondb import Credentials
from chkit_plugin_obsessiondb.jobs_api import jobs_list
from chkit_plugin_obsessiondb.service_api import (
    ConsoleApiError,
    ServiceNotFoundError,
    list_service_organizations,
)

BASE = "https://api.test.obsessiondb.com"
JSON = "application/json"
UNPARSABLE = "Cannot parse response body, please check the response body and content-type."


def _creds() -> Credentials:
    return Credentials(access_token="tok", base_url=BASE)


def _orpc(error: dict[str, Any]) -> str:
    return json.dumps({"json": error})


def _error(code: Any, status: Any, message: Any = None, **extra: Any) -> dict[str, Any]:
    error: dict[str, Any] = {"defined": False, "code": code, "status": status, **extra}
    if message is not None:
        error["message"] = message
    return error


# name: (HTTP status, content type or None, body, extra headers), expected
# (message, code); code None is a plain error, whose --json code is `error`.
CASES: dict[str, tuple[tuple[int, str | None, str, dict[str, str]], tuple[str, str | None]]] = {
    "orpc_500_message": (
        (500, JSON, _orpc(_error("INTERNAL_SERVER_ERROR", 500, "boom")), {}),
        ("boom", "INTERNAL_SERVER_ERROR"),
    ),
    "orpc_400_with_data": (
        (400, JSON, _orpc(_error("BAD_REQUEST", 400, "Input validation failed", data={"issues": []})), {}),
        ("Input validation failed", "BAD_REQUEST"),
    ),
    "orpc_403_defined_custom": (
        (403, JSON, _orpc({"defined": True, "code": "QUOTA_EXCEEDED", "status": 403, "message": "quota exceeded"}), {}),
        ("quota exceeded", "QUOTA_EXCEEDED"),
    ),
    "orpc_empty_message_common_code": (
        (403, JSON, _orpc(_error("FORBIDDEN", 403, "")), {}),
        ("Forbidden", "FORBIDDEN"),
    ),
    "orpc_empty_message_custom_code": (
        (409, JSON, _orpc(_error("CUSTOM_CODE", 409, "")), {}),
        ("CUSTOM_CODE", "CUSTOM_CODE"),
    ),
    "orpc_empty_message_prototype_key": (
        (409, JSON, _orpc(_error("toString", 409, "")), {}),
        ("toString", "toString"),
    ),
    "orpc_status_differs_from_http": (
        (500, JSON, _orpc(_error("CONFLICT", 409, "already exists")), {}),
        ("already exists", "CONFLICT"),
    ),
    "orpc_float_status": (
        (500, JSON, _orpc(_error("X", 450.5, "float status")), {}),
        ("float status", "X"),
    ),
    "orpc_status_below_200": (
        (500, JSON, _orpc(_error("X", 100, "low status")), {}),
        ("low status", "X"),
    ),
    "orpc_with_empty_meta": (
        (500, JSON, json.dumps({"json": _error("X", 500, "with meta"), "meta": []}), {}),
        ("with meta", "X"),
    ),
    "orpc_json_charset": (
        (500, "application/json; charset=utf-8", _orpc(_error("X", 500, "charset")), {}),
        ("charset", "X"),
    ),
    "orpc_without_content_type": (
        (500, None, _orpc(_error("X", 500, "no content type")), {}),
        ("no content type", "X"),
    ),
    # Not an oRPC error: the HTTP status's code and default message.
    "orpc_without_message": (
        (500, JSON, _orpc(_error("INTERNAL_SERVER_ERROR", 500)), {}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "orpc_extra_key": (
        (500, JSON, _orpc(_error("X", 500, "m", extra=1)), {}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "orpc_success_status": (
        (500, JSON, _orpc(_error("X", 200, "m")), {}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "orpc_string_status": (
        (500, JSON, _orpc(_error("X", "500", "m")), {}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "orpc_defined_not_boolean": (
        (500, JSON, _orpc({"defined": 0, "code": "X", "status": 500, "message": "m"}), {}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "orpc_boolean_status": (
        (500, JSON, _orpc({"defined": False, "code": "X", "status": True, "message": "m"}), {}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "orpc_without_envelope": (
        (500, JSON, json.dumps(_error("X", 500, "unwrapped")), {}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "json_error_field": (
        (500, JSON, json.dumps({"error": "Service not found"}), {}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "json_envelope_null": ((500, JSON, '{"json":null}', {}), ("Internal Server Error", "INTERNAL_SERVER_ERROR")),
    "json_array": ((500, JSON, "[1,2]", {}), ("Internal Server Error", "INTERNAL_SERVER_ERROR")),
    "json_string": ((500, JSON, '"boom"', {}), ("Internal Server Error", "INTERNAL_SERVER_ERROR")),
    "json_number": ((502, JSON, "5", {}), ("Bad Gateway", "BAD_GATEWAY")),
    "json_uppercase_content_type": (
        (500, "Application/JSON", _orpc(_error("X", 500, "upper")), {}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "text_plain": ((500, "text/plain; charset=utf-8", "boom", {}), ("Internal Server Error", "INTERNAL_SERVER_ERROR")),
    "text_plain_orpc": (
        (500, "text/plain", _orpc(_error("X", 500, "as text")), {}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "html_502": ((502, "text/html", "<html>Bad gateway</html>", {}), ("Bad Gateway", "BAD_GATEWAY")),
    "form_urlencoded": ((500, "application/x-www-form-urlencoded", "a=1", {}), ("Internal Server Error", "INTERNAL_SERVER_ERROR")),
    "octet_stream": ((500, "application/octet-stream", "xx", {}), ("Internal Server Error", "INTERNAL_SERVER_ERROR")),
    "content_disposition": (
        (500, JSON, _orpc(_error("X", 500, "attached")), {"content-disposition": 'attachment; filename="e.json"'}),
        ("Internal Server Error", "INTERNAL_SERVER_ERROR"),
    ),
    "empty_500": ((500, None, "", {}), ("Internal Server Error", "INTERNAL_SERVER_ERROR")),
    "empty_json_503": ((503, JSON, "", {}), ("Service Unavailable", "SERVICE_UNAVAILABLE")),
    "empty_400": ((400, None, "", {}), ("Bad Request", "BAD_REQUEST")),
    "empty_403": ((403, None, "", {}), ("Forbidden", "FORBIDDEN")),
    "empty_404": ((404, None, "", {}), ("Not Found", "NOT_FOUND")),
    "empty_422": ((422, None, "", {}), ("Unprocessable Content", "UNPROCESSABLE_CONTENT")),
    "empty_429": ((429, None, "", {}), ("Too Many Requests", "TOO_MANY_REQUESTS")),
    "empty_504": ((504, None, "", {}), ("Gateway Timeout", "GATEWAY_TIMEOUT")),
    "empty_418": ((418, None, "", {}), ("MALFORMED_ORPC_ERROR_RESPONSE", "MALFORMED_ORPC_ERROR_RESPONSE")),
    "empty_599": ((599, None, "", {}), ("MALFORMED_ORPC_ERROR_RESPONSE", "MALFORMED_ORPC_ERROR_RESPONSE")),
    # Bodies RPCLink cannot decode: a plain error.
    "json_null": ((500, JSON, "null", {}), ("Invalid RPC response format.", None)),
    "text_without_content_type": ((500, None, "boom", {}), (UNPARSABLE, None)),
    "invalid_json": ((500, JSON, "not json", {}), (UNPARSABLE, None)),
    "whitespace_json": ((500, JSON, "   ", {}), (UNPARSABLE, None)),
    "ok_invalid_json": ((200, JSON, "not json", {}), (UNPARSABLE, None)),
    "ok_text_without_content_type": ((200, None, "boom", {}), (UNPARSABLE, None)),
}


@pytest.mark.parametrize(("response", "expected"), list(CASES.values()), ids=list(CASES))
def test_console_api_errors_read_as_in_ts(
    httpx_mock: HTTPXMock,
    response: tuple[int, str | None, str, dict[str, str]],
    expected: tuple[str, str | None],
) -> None:
    status, content_type, body, extra_headers = response
    headers = dict(extra_headers)
    if content_type is not None:
        headers["content-type"] = content_type
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/listAll",
        status_code=status,
        headers=headers,
        content=body.encode(),
    )
    message, code = expected

    with pytest.raises(RuntimeError) as excinfo:
        list_service_organizations(_creds())

    assert str(excinfo.value) == message
    assert isinstance(excinfo.value, ConsoleApiError) == (code is not None)
    assert json_error_code(excinfo.value) == (code or "error")


@pytest.mark.parametrize(
    "error",
    [httpx.ConnectError("Connection refused"), httpx.ReadTimeout("timed out")],
    ids=["connect_error", "timeout"],
)
def test_network_failure_reads_as_fetch_failed(
    httpx_mock: HTTPXMock, error: httpx.TransportError
) -> None:
    httpx_mock.add_exception(error, url=f"{BASE}/rpc/services/listAll")

    with pytest.raises(RuntimeError) as excinfo:
        list_service_organizations(_creds())

    assert str(excinfo.value) == "fetch failed"
    assert json_error_code(excinfo.value) == "error"
    assert excinfo.value.__cause__ is error


# A call for a service explains a NOT_FOUND oRPC error, whatever its HTTP status,
# and nothing else.

_ORGS = {
    "organizations": [
        {"id": "org-acme", "name": "Acme", "slug": "acme", "services": []},
        {
            "id": "org-bench",
            "name": "Benchmarks",
            "slug": "bench",
            "services": [
                {
                    "id": "s1",
                    "slug": "benchmarks",
                    "name": "benchmarks",
                    "status": "running",
                    "tier": 1,
                    "nodes": 1,
                    "desiredStatus": "running",
                    "desiredTier": 1,
                    "desiredNodes": 1,
                    "createdAt": "2026-01-01T00:00:00Z",
                    "managed": False,
                }
            ],
        },
    ]
}
_NOT_IN_ACTIVE_ORG = (
    'obsessiondb: service "benchmarks" is not in the active organization "Acme" of this '
    'chkit session (it belongs to "Benchmarks"). The ObsessionDB console only finds '
    "services in the session's active organization, and switching organizations in the "
    "console does not change the chkit session's. Select a service from \"Acme\" with "
    "`chkit obsessiondb service select`."
)


def _mock_lookup(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=f"{BASE}/rpc/services/listAll", json={"json": _ORGS})
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={
            "user": {"id": "u1", "name": "U", "email": "u@example.test"},
            "session": {"activeOrganizationId": "org-acme"},
        },
    )


@pytest.mark.parametrize(
    ("status", "content_type", "body"),
    [
        (500, JSON, _orpc(_error("NOT_FOUND", 404, "gone"))),
        (404, "text/plain", "Not Found"),
    ],
    ids=["orpc_not_found_on_500", "text_plain_404"],
)
def test_a_not_found_error_is_explained(
    httpx_mock: HTTPXMock, status: int, content_type: str, body: str
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/list",
        status_code=status,
        headers={"content-type": content_type},
        content=body.encode(),
    )
    _mock_lookup(httpx_mock)

    with pytest.raises(ServiceNotFoundError) as excinfo:
        jobs_list(_creds(), service_slug="benchmarks")

    assert str(excinfo.value) == _NOT_IN_ACTIVE_ORG
    assert excinfo.value.code == "service_not_in_active_organization"


@pytest.mark.parametrize(
    ("status", "content_type", "body", "message"),
    [
        (404, JSON, _orpc(_error("SERVICE_MISSING", 404, "missing")), "missing"),
        (404, None, "Not Found", UNPARSABLE),
    ],
    ids=["orpc_custom_code_on_404", "unparsable_404"],
)
def test_another_error_of_a_404_is_not_explained(
    httpx_mock: HTTPXMock, status: int, content_type: str | None, body: str, message: str
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/list",
        status_code=status,
        headers={"content-type": content_type} if content_type else {},
        content=body.encode(),
    )

    with pytest.raises(RuntimeError) as excinfo:
        jobs_list(_creds(), service_slug="benchmarks")

    assert str(excinfo.value) == message
    assert not isinstance(excinfo.value, ServiceNotFoundError)
    assert len(httpx_mock.get_requests()) == 1
