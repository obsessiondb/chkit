"""`chkit obsessiondb login` and `signup` take the TS flags (#688).

Port of the signup tests in ``packages/cli/src/test/obsessiondb-onboarding.e2e.test.ts``:
the CLI runs against a local stand-in for the ObsessionDB console API, which
``--api-url`` names, so no test calls the real API.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app
from chkit_plugin_obsessiondb import auth_login, load_credentials

EMAIL = "playground@example.com"
# chkit-py reads `name` from the session user; the TS mock leaves it out.
USER = {"id": "u1", "email": EMAIL, "name": "Playground"}


class _ConsoleStub:
    """The console API endpoints that login and signup call, as the TS mock serves them."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.org_names: list[str] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self._reply()

            def do_POST(self) -> None:
                self._reply()

            def _reply(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                stub.calls.append(self.path)
                headers: dict[str, str] = {}
                if self.path == "/api/auth/sign-in/email-otp":
                    headers["set-auth-token"] = "test-token"
                    payload: object = {"user": USER}
                elif self.path == "/api/auth/get-session":
                    payload = {"user": USER, "session": {"activeOrganizationId": None}}
                elif self.path == "/api/auth/organization/create":
                    stub.org_names.append(body["name"])
                    payload = {"id": "org-1"}
                elif self.path == "/api/auth/device/code":
                    payload = {
                        "device_code": "dev-1",
                        "user_code": "ABCD-1234",
                        "verification_uri": "http://127.0.0.1/device",
                        "verification_uri_complete": "http://127.0.0.1/device?code=ABCD-1234",
                        "expires_in": 60,
                        "interval": 0,
                    }
                elif self.path == "/api/auth/device/token":
                    payload = {"access_token": "device-token"}
                elif self.path in (
                    "/api/auth/email-otp/send-verification-otp",
                    "/api/auth/organization/set-active",
                ):
                    payload = {}
                else:
                    self.send_error(404)
                    return
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def sent_otps(self) -> int:
        return self.calls.count("/api/auth/email-otp/send-verification-otp")


@pytest.fixture
def console(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[_ConsoleStub]:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.delenv("OBSESSIONDB_API_URL", raising=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(auth_login, "_open_browser", lambda _url: None)
    _reset_for_testing()
    stub = _ConsoleStub()
    thread = threading.Thread(target=stub.server.serve_forever, daemon=True)
    thread.start()
    yield stub
    stub.server.shutdown()
    stub.server.server_close()
    _reset_for_testing()


def _chkit(*args: str) -> tuple[int, str]:
    result = CliRunner().invoke(app, ["obsessiondb", *args])
    return result.exit_code, result.stdout


def test_two_step_signup_sends_the_code_once_and_verifies_without_resending(
    console: _ConsoleStub,
) -> None:
    base = ["signup", "--api-url", console.url, "--email", EMAIL]

    # Step 1: request the code. Sends exactly one OTP and prints the verify command.
    assert _chkit(*base, "--request-only") == (
        0,
        f"We sent a 6-digit code to {EMAIL}.\n"
        f"Next: chkit obsessiondb signup --email {EMAIL} --code <CODE>\n"
        "Then: chkit obsessiondb service claim\n",
    )
    assert console.sent_otps() == 1
    assert load_credentials() is None

    # Step 2: verify with the code. Must not re-send the OTP (would invalidate the code).
    assert _chkit(*base, "--code", "123456") == (
        0,
        f'Created organization "playground".\nSigned in as {EMAIL}.\n',
    )
    assert console.sent_otps() == 1
    creds = load_credentials()
    assert creds is not None
    assert (creds.access_token, creds.base_url) == ("test-token", console.url)


def test_signup_org_name_names_the_created_organization(console: _ConsoleStub) -> None:
    code, stdout = _chkit(
        "signup",
        "--api-url",
        console.url,
        "--email",
        EMAIL,
        "--code",
        "123456",
        "--org-name",
        "Acme Data",
    )
    assert (code, stdout) == (0, f'Created organization "Acme Data".\nSigned in as {EMAIL}.\n')
    assert console.org_names == ["Acme Data"]


def test_signup_json_prints_the_ts_envelope_at_each_step(console: _ConsoleStub) -> None:
    base = ["signup", "--api-url", console.url, "--email", EMAIL, "--json"]

    code, stdout = _chkit(*base, "--request-only")
    assert code == 0
    assert json.loads(stdout) == {
        "command": "obsessiondb signup",
        "schemaVersion": 1,
        "status": "otp_sent",
        "email": EMAIL,
        "next": {
            "needs": "code",
            "command": f"chkit obsessiondb signup --email {EMAIL} --code <CODE>",
        },
    }

    _reset_for_testing()
    code, stdout = _chkit(*base, "--code", "123456")
    assert code == 0
    assert json.loads(stdout) == {
        "command": "obsessiondb signup",
        "schemaVersion": 1,
        "status": "verified",
        "email": EMAIL,
        "next": {"needs": "claim", "command": "chkit obsessiondb service claim"},
    }


def test_signup_without_an_email_prints_the_ts_runbook_and_fails(
    console: _ConsoleStub,
) -> None:
    assert _chkit("signup", "--api-url", console.url) == (
        1,
        "No email provided. In non-interactive environments, sign up in two steps:\n"
        "  1. chkit obsessiondb signup --email <you@example.com>          "
        "# sends a 6-digit code\n"
        "  2. chkit obsessiondb signup --email <you@example.com> --code <CODE>   "
        "# verifies and signs in\n"
        "Then claim a service: chkit obsessiondb service claim\n",
    )
    assert console.calls == []


def test_signup_json_without_an_email_prints_the_ts_no_email_envelope(
    console: _ConsoleStub,
) -> None:
    code, stdout = _chkit("signup", "--api-url", console.url, "--json")
    assert code == 1
    assert json.loads(stdout) == {
        "command": "obsessiondb signup",
        "schemaVersion": 1,
        "status": "no_email",
        "next": {"needs": "email", "command": "chkit obsessiondb signup --email <you@example.com>"},
    }


def test_login_api_url_logs_in_through_that_url(console: _ConsoleStub) -> None:
    code, stdout = _chkit("login", "--api-url", console.url)
    assert code == 0
    assert stdout.endswith(f"Waiting for authorization...\nLogged in as {EMAIL}\n")
    assert console.calls[:2] == ["/api/auth/device/code", "/api/auth/device/token"]
    creds = load_credentials()
    assert creds is not None
    assert (creds.access_token, creds.base_url) == ("device-token", console.url)
