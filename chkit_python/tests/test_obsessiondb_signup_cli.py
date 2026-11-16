"""`chkit obsessiondb login` and `signup` take the TS flags (#688), and login
offers a service like TS (#737).

Port of the signup tests in ``packages/cli/src/test/obsessiondb-onboarding.e2e.test.ts``:
the CLI runs against a local stand-in for the ObsessionDB console API, which
``--api-url`` names, so no test calls the real API. The expected login
service-selection output and stored selection are what the TS CLI
(``packages/cli/dist/bin/chkit.js obsessiondb login``) printed and wrote
against the same responses.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app
from chkit_plugin_obsessiondb import (
    Credentials,
    auth_login,
    load_credentials,
    save_credentials,
)

EMAIL = "playground@example.com"
# chkit-py reads `name` from the session user; the TS mock leaves it out.
USER = {"id": "u1", "email": EMAIL, "name": "Playground"}
DEVICE_LOGIN_OUTPUT = (
    "\nOpen this URL in your browser:\n  http://127.0.0.1/device?code=ABCD-1234\n\n"
    "Enter code: ABCD-1234\n\n"
    "Waiting for authorization...\n"
    f"Logged in as {EMAIL}\n"
)
SELECT_LATER_HINT = "You can select a service later with: chkit obsessiondb service select\n"


def _service(n: int, status: str = "running") -> dict[str, object]:
    return {
        "id": f"s{n}",
        "slug": f"svc-{n}",
        "name": f"Svc {n}",
        "status": status,
        "tier": 1,
        "nodes": 1,
        "desiredStatus": "running",
        "desiredTier": 1,
        "desiredNodes": 1,
        "createdAt": "2026-01-01T00:00:00Z",
        "managed": False,
    }


ONE_SERVICE: list[dict[str, object]] = [{"id": "o1", "name": "Acme", "slug": "acme", "services": [_service(1)]}]
THREE_SERVICES: list[dict[str, object]] = [
    {"id": "o1", "name": "Acme", "slug": "acme", "services": [_service(1), _service(2, "stopped")]},
    {"id": "o2", "name": "Beta", "slug": "Beta", "services": [_service(3)]},
]
THREE_SERVICES_OUTPUT = (
    "\nAvailable services:\n"
    "Acme (acme):\n"
    "  1. Svc 1 (running)\n"
    "  2. Svc 2 (stopped)\n"
    "Beta:\n"
    "  3. Svc 3 (running)\n"
)
# The picker prompt goes to stderr, as in TS (#740).
THREE_SERVICES_PROMPT = "\nSelect service [1-3]: "


class _ConsoleStub:
    """The console API endpoints that login and signup call, as the TS mock serves them."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.org_names: list[str] = []
        self.organizations: list[dict[str, object]] = []
        self.list_all_fails = False
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
                elif self.path == "/rpc/services/listAll":
                    if stub.list_all_fails:
                        self.send_error(401)
                        return
                    payload = {"json": {"organizations": stub.organizations}}
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


def _chkit(*args: str, stdin: str = "") -> tuple[int, str]:
    result = CliRunner().invoke(app, ["obsessiondb", *args], input=stdin)
    return result.exit_code, result.stdout


def _chkit_streams(*args: str, stdin: str = "") -> tuple[int, str, str]:
    result = CliRunner().invoke(app, ["obsessiondb", *args], input=stdin)
    return result.exit_code, result.stdout, result.stderr


def _selected_service(tmp_path: Path) -> object:
    """The selection login stored; with no config file it is the user-global one."""
    path = tmp_path / "xdg" / "chkit" / "obsessiondb.json"
    if not path.exists():
        return None
    stored = json.loads(path.read_text())
    return {"service_slug": stored["service_slug"], "service_name": stored["service_name"]}


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
    assert stdout == DEVICE_LOGIN_OUTPUT + "No services found.\n"
    assert console.calls[:2] == ["/api/auth/device/code", "/api/auth/device/token"]
    creds = load_credentials()
    assert creds is not None
    assert (creds.access_token, creds.base_url) == ("device-token", console.url)


def test_login_auto_selects_the_only_service(console: _ConsoleStub, tmp_path: Path) -> None:
    console.organizations = ONE_SERVICE
    assert _chkit("login", "--api-url", console.url) == (
        0,
        DEVICE_LOGIN_OUTPUT
        + "Auto-selected service: Acme (acme) / Svc 1 (running)\n"
        + "Service selected: Acme (acme) / Svc 1\n",
    )
    assert _selected_service(tmp_path) == {"service_slug": "svc-1", "service_name": "Svc 1"}


# With a TTY, login reads the answer like TS, with parseInt ("2x" picks 2).
@pytest.mark.parametrize("answer", ["2\n", "2x\n"])
def test_login_reads_the_service_choice_from_stdin(
    console: _ConsoleStub, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, answer: str
) -> None:
    monkeypatch.setattr(auth_login, "_stdin_is_tty", lambda: True)
    console.organizations = THREE_SERVICES
    assert _chkit_streams("login", "--api-url", console.url, stdin=answer) == (
        0,
        DEVICE_LOGIN_OUTPUT + THREE_SERVICES_OUTPUT + "Service selected: Acme (acme) / Svc 2\n",
        THREE_SERVICES_PROMPT,
    )
    assert _selected_service(tmp_path) == {"service_slug": "svc-2", "service_name": "Svc 2"}


@pytest.mark.parametrize(
    ("answer", "tail"),
    [("", ""), ("abc\n", "Invalid selection.\n"), ("9\n", "Invalid selection.\n")],
)
def test_login_without_a_valid_choice_selects_nothing_and_succeeds(
    console: _ConsoleStub,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    answer: str,
    tail: str,
) -> None:
    monkeypatch.setattr(auth_login, "_stdin_is_tty", lambda: True)
    console.organizations = THREE_SERVICES
    assert _chkit_streams("login", "--api-url", console.url, stdin=answer) == (
        0,
        DEVICE_LOGIN_OUTPUT + THREE_SERVICES_OUTPUT + tail,
        THREE_SERVICES_PROMPT,
    )
    assert _selected_service(tmp_path) is None


def test_login_without_a_tty_skips_the_choice_and_prints_the_hint(
    console: _ConsoleStub, tmp_path: Path
) -> None:
    """CliRunner's stdin is not a TTY, so the piped answer is not read (#739)."""
    console.organizations = THREE_SERVICES
    assert _chkit("login", "--api-url", console.url, stdin="2\n") == (
        0,
        DEVICE_LOGIN_OUTPUT + SELECT_LATER_HINT,
    )
    assert _selected_service(tmp_path) is None


def test_login_without_a_tty_still_auto_selects_the_only_service(
    console: _ConsoleStub, tmp_path: Path
) -> None:
    console.organizations = ONE_SERVICE
    assert _chkit("login", "--api-url", console.url) == (
        0,
        DEVICE_LOGIN_OUTPUT
        + "Auto-selected service: Acme (acme) / Svc 1 (running)\n"
        + "Service selected: Acme (acme) / Svc 1\n",
    )
    assert _selected_service(tmp_path) == {"service_slug": "svc-1", "service_name": "Svc 1"}


def test_login_returns_while_stdin_is_an_open_pipe_without_data(
    console: _ConsoleStub, tmp_path: Path
) -> None:
    """A parent that keeps the pipe open and sends nothing must not hang login (#739)."""
    save_credentials(Credentials(access_token="old-token", base_url=console.url))
    console.organizations = THREE_SERVICES
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "from chkit.cli.main import app; app()",
            "obsessiondb",
            "login",
            "--api-url",
            console.url,
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    # wait(), not communicate(): communicate() closes stdin, which would end the
    # prompt with EOF. The output is small enough not to fill the pipes.
    try:
        returncode = child.wait(timeout=30)
    finally:
        child.kill()
        assert child.stdin is not None
        child.stdin.close()
    assert child.stdout is not None
    assert child.stderr is not None
    assert (returncode, child.stdout.read(), child.stderr.read()) == (
        0,
        f"Already logged in as {EMAIL}\n" + SELECT_LATER_HINT,
        "",
    )
    assert _selected_service(tmp_path) is None


def test_login_prints_the_ts_hint_when_services_cannot_be_listed(
    console: _ConsoleStub, tmp_path: Path
) -> None:
    console.list_all_fails = True
    assert _chkit("login", "--api-url", console.url) == (
        0,
        DEVICE_LOGIN_OUTPUT
        + "Could not fetch services: Session expired. "
        + "Run `chkit obsessiondb login` to re-authenticate.\n"
        + "You can select a service later with: chkit obsessiondb service select\n",
    )
    assert load_credentials() is not None
    assert _selected_service(tmp_path) is None


def test_already_logged_in_without_a_service_offers_one(
    console: _ConsoleStub, tmp_path: Path
) -> None:
    save_credentials(Credentials(access_token="old-token", base_url=console.url))
    console.organizations = ONE_SERVICE
    assert _chkit("login", "--api-url", console.url) == (
        0,
        f"Already logged in as {EMAIL}\n"
        "Auto-selected service: Acme (acme) / Svc 1 (running)\n"
        "Service selected: Acme (acme) / Svc 1\n",
    )
    assert _selected_service(tmp_path) == {"service_slug": "svc-1", "service_name": "Svc 1"}


def test_already_logged_in_with_a_service_lists_nothing(
    console: _ConsoleStub, tmp_path: Path
) -> None:
    save_credentials(Credentials(access_token="old-token", base_url=console.url))
    (tmp_path / "xdg" / "chkit" / "obsessiondb.json").write_text(
        '{"service_slug": "x", "service_name": "X"}\n'
    )
    console.organizations = ONE_SERVICE
    assert _chkit("login", "--api-url", console.url) == (0, f"Already logged in as {EMAIL}\n")
    assert "/rpc/services/listAll" not in console.calls
    assert _selected_service(tmp_path) == {"service_slug": "x", "service_name": "X"}


def test_login_json_prints_each_line_as_a_message_envelope(
    console: _ConsoleStub, tmp_path: Path
) -> None:
    console.organizations = ONE_SERVICE
    code, stdout = _chkit("login", "--api-url", console.url, "--json")
    assert code == 0
    decoder = json.JSONDecoder()
    messages: list[str] = []
    rest = stdout.strip()
    while rest:
        envelope, end = decoder.raw_decode(rest)
        messages.append(envelope["message"])
        rest = rest[end:].strip()
    assert messages[-3:] == [
        f"Logged in as {EMAIL}",
        "Auto-selected service: Acme (acme) / Svc 1 (running)",
        "Service selected: Acme (acme) / Svc 1",
    ]
    assert _selected_service(tmp_path) == {"service_slug": "svc-1", "service_name": "Svc 1"}


def _json_messages(stdout: str) -> list[str]:
    """Decode stdout as back-to-back JSON envelopes; fails on anything else in it."""
    decoder = json.JSONDecoder()
    messages: list[str] = []
    rest = stdout.strip()
    while rest:
        envelope, end = decoder.raw_decode(rest)
        messages.append(envelope["message"])
        rest = rest[end:].strip()
    return messages


THREE_SERVICES_MESSAGES = [
    "\nAvailable services:",
    "Acme (acme):",
    "  1. Svc 1 (running)",
    "  2. Svc 2 (stopped)",
    "Beta:",
    "  3. Svc 3 (running)",
    "Service selected: Acme (acme) / Svc 2",
]


# #740: under --json, stdout holds only JSON; the picker prompt goes to stderr.
def test_login_json_prints_the_service_prompt_on_stderr(
    console: _ConsoleStub, tmp_path: Path
) -> None:
    save_credentials(Credentials(access_token="old-token", base_url=console.url))
    console.organizations = THREE_SERVICES
    result = CliRunner().invoke(
        app, ["obsessiondb", "login", "--api-url", console.url, "--json"], input="2\n"
    )
    assert result.exit_code == 0
    assert _json_messages(result.stdout) == [
        f"Already logged in as {EMAIL}",
        *THREE_SERVICES_MESSAGES,
    ]
    assert "\nSelect service [1-3]: " in result.stderr
    assert _selected_service(tmp_path) == {"service_slug": "svc-2", "service_name": "Svc 2"}


def test_service_select_json_prints_the_prompt_on_stderr(
    console: _ConsoleStub, tmp_path: Path
) -> None:
    save_credentials(Credentials(access_token="old-token", base_url=console.url))
    console.organizations = THREE_SERVICES
    result = CliRunner().invoke(app, ["obsessiondb", "service", "select", "--json"], input="2\n")
    assert result.exit_code == 0
    assert _json_messages(result.stdout) == THREE_SERVICES_MESSAGES
    assert "\nSelect service [1-3]: " in result.stderr
    assert _selected_service(tmp_path) == {"service_slug": "svc-2", "service_name": "Svc 2"}
