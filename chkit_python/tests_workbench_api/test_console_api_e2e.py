"""chkit-py console API models against the real ObsessionDB console API (#288).

Every model is checked against the raw wire payload of the same call, so a
field the model cannot read (the API speaks camelCase) fails here instead of
in a customer's ``chkit obsessiondb service list``.

Read-only: lists services, reads the one named by
``CHKIT_E2E_OBSESSIONDB_SERVICE``, asks for the instance claim status, lists
its jobs and reads the session. It never claims, creates or changes anything.

Opt-in like the cluster suites (outside ``testpaths``). Needs a
``chkit obsessiondb login`` session (``~/.config/chkit/credentials.json``) and
the service slug::

    CHKIT_E2E_OBSESSIONDB_SERVICE=<slug> .venv/bin/python -m pytest tests_workbench_api

Hard-fails (never skips) without them.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit_plugin_obsessiondb.api_client import get_session
from chkit_plugin_obsessiondb.credentials import Credentials, load_credentials
from chkit_plugin_obsessiondb.jobs_api import jobs_list
from chkit_plugin_obsessiondb.service_api import (
    _rpc_post,
    get_service,
    instance_claim_status,
    list_service_organizations,
    list_services,
)

CONFIG = """
from chkit import define_config
from chkit_plugin_obsessiondb import obsessiondb

config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "plugins": [obsessiondb()],
    }
)
"""

SCHEMA = """
from chkit import schema

definitions = schema()
"""


def test_list_all_parses_every_organization_and_service() -> None:
    creds = _credentials()
    raw = _rpc_post(creds, "services/listAll", {})

    organizations = list_service_organizations(creds)

    assert [org.id for org in organizations] == [o["id"] for o in raw["organizations"]]
    assert [len(org.services) for org in organizations] == [
        len(o["services"]) for o in raw["organizations"]
    ]
    service = _find(list_services(creds), _service_slug())
    _assert_matches_wire(service, _find_raw(raw, _service_slug()))


def test_get_service_matches_the_wire_and_the_listed_service() -> None:
    creds = _credentials()
    slug = _service_slug()
    raw = _rpc_post(creds, "services/get", {"serviceSlug": slug})

    service = get_service(creds, service_slug=slug)

    assert service.slug == slug
    _assert_matches_wire(service, raw)
    assert service == _find(list_services(creds), slug)


def test_instance_claim_status_matches_the_wire() -> None:
    creds = _credentials()
    raw = _rpc_post(creds, "services/instanceClaimStatus", {})

    status = instance_claim_status(creds)

    _assert_matches_wire(status, raw)


def test_jobs_list_matches_the_wire() -> None:
    creds = _credentials()
    raw = _rpc_post(creds, "jobs/list", {"serviceSlug": _service_slug()})

    listed = jobs_list(creds, service_slug=_service_slug())

    assert listed.total == raw["total"]
    assert len(listed.jobs) == len(raw["jobs"])
    for job, raw_job in zip(listed.jobs, raw["jobs"], strict=True):
        _assert_matches_wire(job, raw_job)


def test_get_session_reads_the_active_organization() -> None:
    creds = _credentials()
    raw = httpx.get(
        f"{creds.base_url}/api/auth/get-session",
        headers={"Authorization": f"Bearer {creds.access_token}"},
        timeout=30.0,
    ).json()

    session = get_session(creds.base_url, creds.access_token)

    assert raw["session"]["activeOrganizationId"]
    assert session.session is not None
    assert session.session.active_organization_id == raw["session"]["activeOrganizationId"]
    _assert_matches_wire(session.user, raw["user"])


def test_service_list_json_lists_every_service(tmp_path: Path) -> None:
    creds = _credentials()
    raw = _rpc_post(creds, "services/listAll", {})

    envelope = _run_cli(tmp_path, ["obsessiondb", "service", "list", "--json"])

    assert {k: v for k, v in envelope.items() if k != "services"} == {
        "command": "obsessiondb service list",
        "schemaVersion": 1,
        "status": "ok",
    }
    assert [{k: v for k, v in s.items() if k != "selected"} for s in envelope["services"]] == [
        {"organization": org["name"], "slug": s["slug"], "name": s["name"]}
        for org in raw["organizations"]
        for s in org["services"]
    ]
    assert all(isinstance(s["selected"], bool) for s in envelope["services"])
    assert _service_slug() in [s["slug"] for s in envelope["services"]]


def test_whoami_json_reports_the_session_email(tmp_path: Path) -> None:
    creds = _credentials()
    raw = httpx.get(
        f"{creds.base_url}/api/auth/get-session",
        headers={"Authorization": f"Bearer {creds.access_token}"},
        timeout=30.0,
    ).json()

    envelope = _run_cli(tmp_path, ["obsessiondb", "whoami", "--json"])

    assert envelope == {
        "command": "obsessiondb whoami",
        "schemaVersion": 1,
        "status": "logged_in",
        "email": raw["user"]["email"],
        "next": None,
    }


def _assert_matches_wire(model: BaseModel, wire: dict[str, Any]) -> None:
    """Every field the model declares carries the wire value under its alias."""
    dumped = model.model_dump(by_alias=True)
    assert dumped == {key: wire[key] for key in dumped}


def _run_cli(project: Path, args: list[str]) -> dict[str, Any]:
    (project / "clickhouse.config.py").write_text(CONFIG, encoding="utf-8")
    (project / "schema.py").write_text(SCHEMA, encoding="utf-8")
    result = CliRunner().invoke(
        app, [*args, "--config", str(project / "clickhouse.config.py")]
    )
    assert result.exit_code == 0, f"exit {result.exit_code}\n{result.output}\n{result.exception!r}"
    parsed: dict[str, Any] = json.loads(result.output)
    return parsed


def _find_raw(raw: dict[str, Any], slug: str) -> dict[str, Any]:
    matches = [s for o in raw["organizations"] for s in o["services"] if s["slug"] == slug]
    assert len(matches) == 1, f"service {slug!r} not visible to this session"
    found: dict[str, Any] = matches[0]
    return found


def _find(services: list[Any], slug: str) -> Any:
    matches = [s for s in services if s.slug == slug]
    assert len(matches) == 1, f"service {slug!r} not visible to this session"
    return matches[0]


def _service_slug() -> str:
    service = os.environ.get("CHKIT_E2E_OBSESSIONDB_SERVICE", "")
    assert service, "set CHKIT_E2E_OBSESSIONDB_SERVICE to the ObsessionDB service slug"
    return service


def _credentials() -> Credentials:
    credentials = load_credentials()
    assert credentials is not None, "run `chkit obsessiondb login` first"
    return credentials
