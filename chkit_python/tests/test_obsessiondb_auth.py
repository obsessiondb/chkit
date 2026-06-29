"""Tests for `chkit_plugin_obsessiondb.auth_login` + `auth_signup`."""

from __future__ import annotations

from pathlib import Path

import pytest
from pytest_httpx import HTTPXMock

from chkit.cli.plugin_runtime import (
    load_plugin_runtime,
    null_plugin_context,
)
from chkit.cli.table_scope import TableScope
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit.plugins import ChxPluginCommandContext
from chkit_plugin_obsessiondb import (
    Credentials,
    SignupOptions,
    derive_org_name,
    load_credentials,
    obsessiondb,
    run_login,
    run_logout,
    run_signup,
    run_whoami,
    save_credentials,
    slugify_org_name,
)
from chkit_plugin_obsessiondb import auth_login as _auth_login_module

BASE = "https://api.test.obsessiondb.com"


@pytest.fixture
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg_dir = tmp_path / "xdg"
    cfg_dir.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_dir))
    monkeypatch.delenv("OBSESSIONDB_API_URL", raising=False)
    return cfg_dir


@pytest.fixture(autouse=True)
def _no_browser(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub the browser opener so tests never spawn a real subprocess."""
    monkeypatch.setattr(_auth_login_module, "_open_browser", lambda _url: None)


def _captured_log() -> tuple[list[str], list[object]]:
    """Two-list capture: messages (str) + structured envelopes (objects)."""
    str_msgs: list[str] = []
    objs: list[object] = []

    return str_msgs, objs


# ---------- helpers ----------


def test_derive_org_name_strips_plus_subaddress() -> None:
    assert derive_org_name("marc+clisignup@example.com") == "marc"


def test_derive_org_name_falls_back_to_playground() -> None:
    assert derive_org_name("@example.com") == "playground"
    assert derive_org_name("####@example.com") == "playground"


def test_slugify_org_name_appends_random_suffix() -> None:
    a = slugify_org_name("My Org")
    b = slugify_org_name("My Org")
    assert a != b  # random suffix differs
    assert a.startswith("my-org-")


# ---------- run_login ----------


def test_login_short_circuits_when_session_still_valid(
    isolated_home: Path, httpx_mock: HTTPXMock, tmp_path: Path
) -> None:
    save_credentials(Credentials(access_token="tok-existing", base_url=BASE))
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={"user": {"id": "u", "email": "alice@example.com", "name": "A"}},
    )
    messages: list[str] = []
    exit_code = run_login(BASE, tmp_path / "config.py", messages.append)
    assert exit_code == 0
    assert any("Already logged in" in m for m in messages)


def test_login_runs_full_flow_when_no_creds(
    isolated_home: Path, httpx_mock: HTTPXMock, tmp_path: Path
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/code",
        json={
            "device_code": "DEV",
            "user_code": "CODE-1",
            "verification_uri": f"{BASE}/d",
            "verification_uri_complete": f"{BASE}/d?code=CODE-1",
            "expires_in": 60,
            "interval": 0,
        },
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/token", json={"access_token": "tok-new"}
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={"user": {"id": "u", "email": "alice@example.com", "name": "A"}},
    )
    messages: list[str] = []
    code = run_login(BASE, tmp_path / "config.py", messages.append)
    assert code == 0
    assert any("alice@example.com" in m for m in messages)
    # Token should be persisted.
    creds = load_credentials()
    assert creds is not None
    assert creds.access_token == "tok-new"


def test_login_clears_stored_creds_when_session_fails(
    isolated_home: Path, httpx_mock: HTTPXMock, tmp_path: Path
) -> None:
    save_credentials(Credentials(access_token="tok-expired", base_url=BASE))
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session", status_code=401, text="expired"
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/code",
        json={
            "device_code": "DEV",
            "user_code": "C",
            "verification_uri": f"{BASE}/d",
            "verification_uri_complete": f"{BASE}/d",
            "expires_in": 60,
            "interval": 0,
        },
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/device/token", json={"access_token": "tok-fresh"}
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={"user": {"id": "u", "email": "alice@example.com", "name": "A"}},
    )
    messages: list[str] = []
    code = run_login(BASE, tmp_path / "config.py", messages.append)
    assert code == 0
    creds = load_credentials()
    assert creds is not None
    assert creds.access_token == "tok-fresh"


# ---------- run_logout ----------


def test_logout_removes_creds(isolated_home: Path) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    messages: list[str] = []
    code = run_logout(messages.append)
    assert code == 0
    assert "Logged out" in messages[0]
    assert load_credentials() is None


def test_logout_when_no_session_is_silent(isolated_home: Path) -> None:
    messages: list[str] = []
    code = run_logout(messages.append)
    assert code == 0
    assert "No active session" in messages[0]


# ---------- run_whoami ----------


def test_whoami_returns_user_when_logged_in(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={"user": {"id": "u", "email": "a@b.com", "name": "Alice"}},
    )
    msgs: list[object] = []
    code = run_whoami(msgs.append)
    assert code == 0
    assert any("a@b.com" in str(m) for m in msgs)


def test_whoami_json_mode_returns_envelope(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={"user": {"id": "u", "email": "a@b.com", "name": "Alice"}},
    )
    msgs: list[object] = []
    run_whoami(msgs.append, json_mode=True)
    [envelope] = msgs
    assert isinstance(envelope, dict)
    assert envelope["ok"] is True
    assert envelope["user"]["email"] == "a@b.com"


def test_whoami_returns_error_when_no_creds(isolated_home: Path) -> None:
    msgs: list[object] = []
    code = run_whoami(msgs.append)
    assert code == 1
    assert any("Not logged in" in str(m) for m in msgs)


def test_whoami_clears_creds_on_expired_session(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok-stale", base_url=BASE))
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session", status_code=401, text="expired"
    )
    msgs: list[object] = []
    code = run_whoami(msgs.append)
    assert code == 1
    assert load_credentials() is None


# ---------- run_signup ----------


def test_signup_two_step_first_call_only_sends_otp(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/email-otp/send-verification-otp", status_code=204
    )
    msgs: list[object] = []
    code = run_signup(
        BASE,
        msgs.append,
        SignupOptions(email="alice@example.com", request_only=True),
    )
    assert code == 0
    # Static runbook hint (verify-step) is printed.
    assert any("--code" in str(m) for m in msgs)


def test_signup_verify_step_creates_org_when_missing(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/sign-in/email-otp",
        headers={"set-auth-token": "tok-verified"},
        json={"user": {"id": "u", "email": "alice@example.com", "name": "Alice"}},
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={"user": {"id": "u", "email": "alice@example.com", "name": "Alice"}, "session": {}},
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/organization/create", json={"id": "org-new"}
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/organization/set-active", status_code=204
    )
    msgs: list[object] = []
    code = run_signup(
        BASE,
        msgs.append,
        SignupOptions(email="alice@example.com", code="123456"),
    )
    assert code == 0
    creds = load_credentials()
    assert creds is not None
    assert creds.access_token == "tok-verified"


def test_signup_skips_create_org_when_active_org_exists(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/sign-in/email-otp",
        headers={"set-auth-token": "tok"},
        json={"user": {"id": "u", "email": "a@b.com"}},
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={
            "user": {"id": "u", "email": "a@b.com", "name": "A"},
            "session": {"active_organization_id": "org-existing"},
        },
    )
    msgs: list[object] = []
    code = run_signup(
        BASE,
        msgs.append,
        SignupOptions(email="a@b.com", code="123456"),
    )
    assert code == 0
    # We should NOT have hit create-organization — pytest-httpx fails on unused
    # add_response by default, so the absence of an add_response for that URL
    # combined with success here is the assertion.
    assert any("Welcome back" in str(m) for m in msgs)


def test_signup_returns_1_on_rate_limit(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/email-otp/send-verification-otp", status_code=429
    )
    msgs: list[object] = []
    code = run_signup(BASE, msgs.append, SignupOptions(email="a@b.com"))
    assert code == 1
    assert any("Too many code requests" in str(m) for m in msgs)


# ---------- plugin command dispatch ----------


def test_plugin_dispatches_to_login_command(
    isolated_home: Path, httpx_mock: HTTPXMock, tmp_path: Path
) -> None:
    """End-to-end: PluginRuntime.run_plugin_command -> run_login."""
    save_credentials(Credentials(access_token="tok-ok", base_url=BASE))
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={"user": {"id": "u", "email": "alice@example.com", "name": "A"}},
    )

    config = ChxResolvedConfig(
        schema_=["./schema.py"],
        out_dir="./chkit",
        migrations_dir="./chkit/migrations",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )
    runtime = load_plugin_runtime([obsessiondb()])
    msgs: list[object] = []
    code = runtime.run_plugin_command(
        "obsessiondb",
        "login",
        ChxPluginCommandContext(
            plugin_name="obsessiondb",
            config=config,
            config_path=str(tmp_path / "config.py"),
            json_mode=False,
            args=[],
            flags={"--api-url": BASE},
            options={},
            raw_options={},
            table_scope=TableScope(enabled=False),
            print=msgs.append,
            plugin_runtime=runtime,
            plugin_context=null_plugin_context(),
        ),
    )
    assert code == 0
    assert any("Already logged in" in str(m) for m in msgs)
