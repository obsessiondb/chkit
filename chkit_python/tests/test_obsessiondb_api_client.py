"""Tests for `chkit_plugin_obsessiondb.api_client` (HTTP layer).

Uses ``pytest_httpx.HTTPXMock`` to intercept requests so no real ObsessionDB
endpoints are hit.
"""

from __future__ import annotations

import pytest
from pytest_httpx import HTTPXMock

from chkit_plugin_obsessiondb.api_client import (
    OtpRateLimitError,
    create_organization,
    get_session,
    poll_device_token,
    request_device_code,
    send_verification_otp,
    set_active_organization,
    verify_otp,
)

BASE = "https://api.test.obsessiondb.com"


# ---------- request_device_code ----------


def test_request_device_code_happy_path(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/code",
        json={
            "device_code": "DEV-XYZ",
            "user_code": "ABC-123",
            "verification_uri": f"{BASE}/device",
            "verification_uri_complete": f"{BASE}/device?code=ABC-123",
            "expires_in": 600,
            "interval": 5,
        },
    )
    out = request_device_code(BASE)
    assert out.device_code == "DEV-XYZ"
    assert out.user_code == "ABC-123"
    assert out.interval == 5
    assert out.expires_in == 600


def test_request_device_code_raises_on_http_error(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/code", status_code=500, text="boom"
    )
    with pytest.raises(RuntimeError, match="Failed to request device code"):
        request_device_code(BASE)


# ---------- poll_device_token ----------


def test_poll_device_token_returns_token_on_success(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/token",
        json={"error": "authorization_pending"},
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/token",
        json={"access_token": "tok-final"},
    )
    token = poll_device_token(
        BASE, "DEV-XYZ", interval=0.0, expires_in=10.0, sleep=lambda _s: None
    )
    assert token == "tok-final"


def test_poll_device_token_handles_slow_down(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/token", json={"error": "slow_down"}
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/token", json={"access_token": "tok-after-slowdown"}
    )
    token = poll_device_token(
        BASE, "DEV-XYZ", interval=0.0, expires_in=10.0, sleep=lambda _s: None
    )
    assert token == "tok-after-slowdown"


def test_poll_device_token_raises_on_access_denied(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/token", json={"error": "access_denied"}
    )
    with pytest.raises(RuntimeError, match="Authorization denied"):
        poll_device_token(
            BASE, "DEV-XYZ", interval=0.0, expires_in=10.0, sleep=lambda _s: None
        )


def test_poll_device_token_raises_on_expired_token(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/token", json={"error": "expired_token"}
    )
    with pytest.raises(RuntimeError, match="Device code expired"):
        poll_device_token(
            BASE, "DEV-XYZ", interval=0.0, expires_in=10.0, sleep=lambda _s: None
        )


def test_poll_device_token_times_out_when_deadline_passes() -> None:
    counter = {"value": 0.0}

    def fake_monotonic() -> float:
        counter["value"] += 100.0
        return counter["value"]

    with pytest.raises(RuntimeError, match="Device code expired"):
        poll_device_token(
            BASE,
            "DEV-XYZ",
            interval=0.0,
            expires_in=10.0,
            sleep=lambda _s: None,
            monotonic=fake_monotonic,
        )


# ---------- get_session ----------


def test_get_session_parses_response(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={
            "user": {"id": "u1", "email": "alice@example.com", "name": "Alice"},
            "session": {"active_organization_id": "org-1"},
        },
    )
    session = get_session(BASE, "tok-abc")
    assert session.user.email == "alice@example.com"
    assert session.user.name == "Alice"
    assert session.session is not None
    assert session.session.active_organization_id == "org-1"


def test_get_session_handles_no_active_org(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={
            "user": {"id": "u1", "email": "a@b.com", "name": "Z"},
            "session": {},
        },
    )
    session = get_session(BASE, "tok-abc")
    assert session.session is not None
    assert session.session.active_organization_id is None


def test_get_session_raises_on_unauthorized(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session", status_code=401, text="expired"
    )
    with pytest.raises(RuntimeError, match="Failed to get session"):
        get_session(BASE, "tok-expired")


# ---------- send_verification_otp ----------


def test_send_verification_otp_succeeds(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/email-otp/send-verification-otp", status_code=204
    )
    send_verification_otp(BASE, "alice@example.com")


def test_send_verification_otp_raises_on_rate_limit(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/email-otp/send-verification-otp", status_code=429
    )
    with pytest.raises(OtpRateLimitError):
        send_verification_otp(BASE, "alice@example.com")


def test_send_verification_otp_raises_on_server_error(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/email-otp/send-verification-otp",
        status_code=500,
        text="boom",
    )
    with pytest.raises(RuntimeError, match="Failed to send verification"):
        send_verification_otp(BASE, "alice@example.com")


# ---------- verify_otp ----------


def test_verify_otp_returns_token_and_user(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/sign-in/email-otp",
        headers={"set-auth-token": "tok-bearer"},
        json={"user": {"id": "u1", "email": "alice@example.com", "name": "Alice"}},
    )
    result = verify_otp(BASE, "alice@example.com", "123456")
    assert result.token == "tok-bearer"
    assert result.user.email == "alice@example.com"


def test_verify_otp_raises_when_token_header_missing(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/sign-in/email-otp",
        json={"user": {"id": "u1", "email": "a@b.com"}},
    )
    with pytest.raises(RuntimeError, match="no auth token"):
        verify_otp(BASE, "alice@example.com", "123456")


# ---------- create_organization / set_active_organization ----------


def test_create_organization_returns_id(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/organization/create", json={"id": "org-new"}
    )
    out = create_organization(BASE, "tok", name="my org", slug="my-org-abc123")
    assert out["id"] == "org-new"


def test_set_active_organization_succeeds_on_2xx(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/organization/set-active", status_code=204
    )
    set_active_organization(BASE, "tok", "org-1")
