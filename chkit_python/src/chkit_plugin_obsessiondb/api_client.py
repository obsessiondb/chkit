"""ObsessionDB auth API client (HTTP).

1:1 port of ``packages/plugin-obsessiondb/src/auth/api-client.ts``.

Endpoints covered:

- ``POST /api/auth/device/code`` — start device-code flow
- ``POST /api/auth/device/token`` — poll for the access token
- ``GET  /api/auth/get-session`` — read user + active org from a token
- ``POST /api/auth/email-otp/send-verification-otp`` — passwordless step 1
- ``POST /api/auth/sign-in/email-otp`` — passwordless step 2 (returns
  the bearer in the ``set-auth-token`` response header)
- ``POST /api/auth/organization/create``
- ``POST /api/auth/organization/set-active``

The service / jobs / workbench oRPC contracts are not in this turn; they
land alongside the service commands.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

CLIENT_ID = "chkit-cli"
USER_AGENT = "chkit-cli"
HTTP_TIMEOUT_SECONDS = 30.0
HTTP_429_RATE_LIMITED = 429


class SessionExpiredError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(
            "Session expired. Run `chkit obsessiondb login` to re-authenticate."
        )


class OtpRateLimitError(RuntimeError):
    """Raised when the send-OTP endpoint returns HTTP 429."""

    def __init__(self) -> None:
        super().__init__(
            "Too many code requests. Please wait a minute and try again."
        )


def is_session_expired_error(error: BaseException) -> bool:
    return isinstance(error, SessionExpiredError)


@dataclass(frozen=True, slots=True)
class DeviceCodeResponse:
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int


class SessionUser(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    id: str
    name: str
    email: str


class SessionInfo(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore", populate_by_name=True)

    active_organization_id: str | None = None


class SessionResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    user: SessionUser
    session: SessionInfo | None = None


class VerifiedUser(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    id: str
    email: str
    name: str | None = None


@dataclass(frozen=True, slots=True)
class OtpVerifyResult:
    token: str
    user: VerifiedUser


def _default_headers(token: str | None = None) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _client() -> httpx.Client:
    return httpx.Client(timeout=HTTP_TIMEOUT_SECONDS)


def request_device_code(base_url: str) -> DeviceCodeResponse:
    """Start an RFC 8628 device-code flow. Returns the user code + verification URI."""
    with _client() as http:
        res = http.post(
            f"{base_url}/api/auth/device/code",
            headers=_default_headers(),
            json={"client_id": CLIENT_ID},
        )
    if res.status_code >= httpx.codes.BAD_REQUEST:
        msg = f"Failed to request device code: {res.status_code} {res.text}"
        raise RuntimeError(msg)
    body = res.json()
    return DeviceCodeResponse(
        device_code=str(body["device_code"]),
        user_code=str(body["user_code"]),
        verification_uri=str(body["verification_uri"]),
        verification_uri_complete=str(body["verification_uri_complete"]),
        expires_in=int(body["expires_in"]),
        interval=int(body["interval"]),
    )


def poll_device_token(
    base_url: str,
    device_code: str,
    interval: float,
    expires_in: float,
    *,
    sleep: Any = time.sleep,
    monotonic: Any = time.monotonic,
) -> str:
    """Poll until the user authorises the device. Returns the access token."""
    deadline = monotonic() + expires_in
    poll_interval = interval

    while monotonic() < deadline:
        sleep(poll_interval)
        with _client() as http:
            res = http.post(
                f"{base_url}/api/auth/device/token",
                headers=_default_headers(),
                json={
                    "client_id": CLIENT_ID,
                    "device_code": device_code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
            )
        try:
            body = res.json()
        except ValueError:
            body = {}
        access_token = body.get("access_token")
        error = body.get("error")
        if not access_token and not error:
            msg = f"Token poll failed: {res.status_code} {body}"
            raise RuntimeError(msg)
        if access_token:
            return str(access_token)
        if error == "authorization_pending":
            continue
        if error == "slow_down":
            poll_interval += 5
            continue
        if error == "access_denied":
            msg = "Authorization denied by user."
            raise RuntimeError(msg)
        if error == "expired_token":
            msg = "Device code expired. Please try again."
            raise RuntimeError(msg)
        msg = f"Unexpected token poll response: {body}"
        raise RuntimeError(msg)

    msg = "Device code expired. Please try again."
    raise RuntimeError(msg)


def get_session(base_url: str, token: str) -> SessionResponse:
    """Read ``/api/auth/get-session`` → user + active organisation."""
    with _client() as http:
        res = http.get(
            f"{base_url}/api/auth/get-session",
            headers=_default_headers(token),
        )
    if res.status_code >= httpx.codes.BAD_REQUEST:
        msg = f"Failed to get session: {res.status_code} {res.text}"
        raise RuntimeError(msg)
    return SessionResponse.model_validate(res.json())


def send_verification_otp(base_url: str, email: str) -> None:
    """Trigger the passwordless OTP email. ``type='sign-in'`` covers signup + login."""
    with _client() as http:
        res = http.post(
            f"{base_url}/api/auth/email-otp/send-verification-otp",
            headers=_default_headers(),
            json={"email": email, "type": "sign-in"},
        )
    if res.status_code == HTTP_429_RATE_LIMITED:
        raise OtpRateLimitError
    if res.status_code >= httpx.codes.BAD_REQUEST:
        msg = f"Failed to send verification code: {res.status_code} {res.text}"
        raise RuntimeError(msg)


def verify_otp(base_url: str, email: str, otp: str) -> OtpVerifyResult:
    """Verify the OTP. The bearer token is in the ``set-auth-token`` response header."""
    with _client() as http:
        res = http.post(
            f"{base_url}/api/auth/sign-in/email-otp",
            headers=_default_headers(),
            json={"email": email, "otp": otp},
        )
    if res.status_code >= httpx.codes.BAD_REQUEST:
        msg = f"Failed to verify code: {res.status_code} {res.text}"
        raise RuntimeError(msg)
    token = res.headers.get("set-auth-token")
    if not token:
        msg = "Verification succeeded but no auth token was returned by the server."
        raise RuntimeError(msg)
    body = res.json()
    user_payload = body.get("user", {})
    return OtpVerifyResult(token=token, user=VerifiedUser.model_validate(user_payload))


def create_organization(
    base_url: str, token: str, *, name: str, slug: str
) -> dict[str, Any]:
    with _client() as http:
        res = http.post(
            f"{base_url}/api/auth/organization/create",
            headers=_default_headers(token),
            json={"name": name, "slug": slug},
        )
    if res.status_code >= httpx.codes.BAD_REQUEST:
        msg = f"Failed to create organization: {res.status_code} {res.text}"
        raise RuntimeError(msg)
    body: Any = res.json()
    if not isinstance(body, dict):
        return {}
    return body


def set_active_organization(
    base_url: str, token: str, organization_id: str
) -> None:
    with _client() as http:
        res = http.post(
            f"{base_url}/api/auth/organization/set-active",
            headers=_default_headers(token),
            json={"organizationId": organization_id},
        )
    if res.status_code >= httpx.codes.BAD_REQUEST:
        msg = f"Failed to set active organization: {res.status_code} {res.text}"
        raise RuntimeError(msg)
