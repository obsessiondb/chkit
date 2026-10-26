"""Tests for `chkit_plugin_obsessiondb.service_*` modules."""

from __future__ import annotations

from pathlib import Path
from typing import Any

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
    ClaimInstanceClaimed,
    Credentials,
    Service,
    ServiceChoice,
    ServiceOrganization,
    claim_instance,
    instance_claim_status,
    list_service_organizations,
    obsessiondb,
    render_service_organizations,
    run_claim,
    save_credentials,
    select_service_interactive,
    service_choice_label,
)
from chkit_plugin_obsessiondb import service_claim as _service_claim_module
from chkit_plugin_obsessiondb.service_api import (
    ClaimInstanceAlreadyClaimed,
    ClaimInstanceNoneAvailable,
    InstanceClaimStatusEligible,
    InstanceClaimStatusIneligible,
    ServiceNotFoundError,
    SessionExpiredError,
    get_service,
)
from chkit_plugin_obsessiondb.storage import SelectedService
from chkit_plugin_obsessiondb.workbench_api import workbench_query_execute

BASE = "https://api.test.obsessiondb.com"


@pytest.fixture
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg_dir = tmp_path / "xdg"
    cfg_dir.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_dir))
    monkeypatch.delenv("OBSESSIONDB_API_URL", raising=False)
    return cfg_dir


def _creds() -> Credentials:
    return Credentials(access_token="tok-abc", base_url=BASE)


def _service(
    *,
    name: str,
    slug: str,
    status: str = "running",
) -> dict[str, Any]:
    return {
        "id": f"id-{slug}",
        "slug": slug,
        "name": name,
        "status": status,
        "tier": 1,
        "nodes": 1,
        "connectionUrl": None,
        "connectionUsername": None,
        "desiredStatus": "running",
        "desiredTier": 1,
        "desiredNodes": 1,
        "createdAt": "2026-01-01T00:00:00Z",
        "managed": True,
    }


def _org(*, name: str, slug: str, services: list[dict[str, Any]]) -> dict[str, Any]:
    return {"id": f"org-{slug}", "name": name, "slug": slug, "services": services}


# ---------- service_api: RPC layer ----------


def test_list_service_organizations_parses_listAll(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/listAll",
        json={
            "organizations": [
                _org(
                    name="My Org",
                    slug="my-org",
                    services=[_service(name="prod", slug="prod-eu")],
                )
            ]
        },
    )
    orgs = list_service_organizations(_creds())
    assert len(orgs) == 1
    assert orgs[0].name == "My Org"
    assert orgs[0].services[0].slug == "prod-eu"


def test_get_service_reads_the_camel_case_wire_fields(httpx_mock: HTTPXMock) -> None:
    wire = {
        **_service(name="prod", slug="prod-eu"),
        "connectionUrl": "https://prod-eu.example.com:8443",
        "connectionUsername": "default",
        "controlInstanceId": None,
    }
    httpx_mock.add_response(url=f"{BASE}/rpc/services/get", json={"json": wire})

    service = get_service(_creds(), service_slug="prod-eu")

    assert service.connection_url == "https://prod-eu.example.com:8443"
    assert service.connection_username == "default"
    assert service.desired_status == "running"
    assert service.created_at == "2026-01-01T00:00:00Z"
    # Fields outside the TS contract copy (controlInstanceId) are ignored.
    assert service.model_dump(by_alias=True) == {
        key: value for key, value in wire.items() if key != "controlInstanceId"
    }


def test_instance_claim_status_eligible_path(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/instanceClaimStatus",
        json={"eligible": True},
    )
    status = instance_claim_status(_creds())
    assert isinstance(status, InstanceClaimStatusEligible)


def test_instance_claim_status_ineligible_path(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/instanceClaimStatus",
        json={"eligible": False, "claimedOrganizationName": "Acme"},
    )
    status = instance_claim_status(_creds())
    assert isinstance(status, InstanceClaimStatusIneligible)
    assert status.claimed_organization_name == "Acme"


def test_claim_instance_returns_claimed_branch(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/claimInstance",
        json={"outcome": "claimed", "id": "svc-new", "slug": "new-svc"},
    )
    result = claim_instance(_creds())
    assert isinstance(result, ClaimInstanceClaimed)
    assert result.slug == "new-svc"


def test_claim_instance_returns_none_available_branch(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/claimInstance",
        json={"outcome": "none_available"},
    )
    result = claim_instance(_creds())
    assert isinstance(result, ClaimInstanceNoneAvailable)


def test_claim_instance_returns_already_claimed_branch(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/claimInstance",
        json={"outcome": "already_claimed", "claimedOrganizationName": "Acme"},
    )
    result = claim_instance(_creds())
    assert isinstance(result, ClaimInstanceAlreadyClaimed)
    assert result.claimed_organization_name == "Acme"


def test_rpc_post_raises_session_expired_on_401(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/listAll", status_code=401, text="expired"
    )
    with pytest.raises(SessionExpiredError):
        list_service_organizations(_creds())


def test_rpc_post_raises_runtime_error_on_5xx(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/listAll", status_code=500, text="boom"
    )
    with pytest.raises(RuntimeError, match="RPC services/listAll failed"):
        list_service_organizations(_creds())


# #305: the console resolves a slug in the session's active organization only
# and answers a service of another organization with a bare 404.


def _mock_service_lookup(httpx_mock: HTTPXMock, *, active_org_id: str | None) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        status_code=404,
        json={"error": "Service not found"},
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/listAll",
        json={
            "json": {
                "organizations": [
                    _org(name="Acme", slug="acme", services=[_service(name="prod", slug="prod")]),
                    _org(
                        name="Benchmarks",
                        slug="bench",
                        services=[_service(name="benchmarks", slug="benchmarks")],
                    ),
                ]
            }
        },
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={
            "user": {"id": "u1", "name": "User", "email": "user@example.test"},
            "session": {"activeOrganizationId": active_org_id},
        },
    )


def test_rpc_post_explains_a_service_of_another_organization(
    httpx_mock: HTTPXMock,
) -> None:
    _mock_service_lookup(httpx_mock, active_org_id="org-acme")
    with pytest.raises(ServiceNotFoundError) as excinfo:
        workbench_query_execute(_creds(), service_slug="benchmarks", query="SELECT 1")
    assert excinfo.value.code == "service_not_in_active_organization"
    message = str(excinfo.value)
    assert (
        'service "benchmarks" is not in the active organization "Acme" of this '
        'chkit session (it belongs to "Benchmarks")'
    ) in message
    assert 'Select a service from "Acme" with `chkit obsessiondb service select`' in message


def test_rpc_post_reports_a_service_no_organization_has(httpx_mock: HTTPXMock) -> None:
    _mock_service_lookup(httpx_mock, active_org_id="org-acme")
    with pytest.raises(ServiceNotFoundError) as excinfo:
        workbench_query_execute(_creds(), service_slug="gone", query="SELECT 1")
    assert excinfo.value.code == "service_not_found"
    assert 'service "gone" was not found in any organization you can access' in str(
        excinfo.value
    )


def test_rpc_post_keeps_the_404_when_the_service_is_in_the_active_organization(
    httpx_mock: HTTPXMock,
) -> None:
    _mock_service_lookup(httpx_mock, active_org_id="org-bench")
    with pytest.raises(RuntimeError, match="RPC workbench/query/execute failed: 404") as excinfo:
        workbench_query_execute(_creds(), service_slug="benchmarks", query="SELECT 1")
    assert not isinstance(excinfo.value, ServiceNotFoundError)


def test_rpc_post_keeps_the_404_when_the_lookup_fails(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute", status_code=404, text="Not Found"
    )
    httpx_mock.add_response(url=f"{BASE}/rpc/services/listAll", status_code=500, text="boom")
    with pytest.raises(RuntimeError, match="RPC workbench/query/execute failed: 404"):
        workbench_query_execute(_creds(), service_slug="benchmarks", query="SELECT 1")


def test_rpc_post_does_not_look_up_a_404_without_a_service(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/listAll", status_code=404, text="Not Found"
    )
    with pytest.raises(RuntimeError, match="RPC services/listAll failed: 404"):
        list_service_organizations(_creds())
    assert len(httpx_mock.get_requests()) == 1


# ---------- service_select: pure rendering ----------


def _org_obj() -> ServiceOrganization:
    return ServiceOrganization(
        id="org-1",
        name="My Org",
        slug="my-org",
        services=[
            Service.model_validate(_service(name="prod", slug="prod-eu")),
            Service.model_validate(
                _service(name="dev", slug="dev-us", status="provisioning")
            ),
        ],
    )


def test_render_service_organizations_lists_each_service() -> None:
    lines = render_service_organizations([_org_obj()])
    joined = "\n".join(lines)
    assert "Services:" in joined
    assert "prod (running)" in joined
    assert "dev (provisioning)" in joined


def test_render_service_organizations_marks_selected_with_default() -> None:
    selected = SelectedService(
        organization_id="org-1",
        organization_slug="my-org",
        service_id="id-prod-eu",
        service_name="prod",
        service_slug="prod-eu",
    )
    lines = render_service_organizations([_org_obj()], selected=selected)
    assert any("[default]" in line and "prod" in line for line in lines)


def test_render_service_organizations_empty_input() -> None:
    assert render_service_organizations([]) == ["No services found."]


def test_select_service_interactive_auto_selects_when_single_choice() -> None:
    single = ServiceOrganization(
        id="o",
        name="org",
        slug="org",
        services=[Service.model_validate(_service(name="only", slug="only-svc"))],
    )
    msgs: list[str] = []
    choice = select_service_interactive([single], msgs.append)
    assert choice is not None
    assert choice.service.slug == "only-svc"
    assert any("Auto-selected" in m for m in msgs)


def test_select_service_interactive_returns_none_when_no_services() -> None:
    msgs: list[str] = []
    assert select_service_interactive([], msgs.append) is None
    assert msgs == ["No services found."]


def test_service_choice_label_format() -> None:
    org = _org_obj()
    choice = ServiceChoice(organization=org, service=org.services[0])
    label = service_choice_label(choice)
    assert "prod" in label
    assert "my-org" in label or "My Org" in label


def test_select_service_interactive_picks_index_from_stdin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    orgs = [_org_obj()]

    class _Fake:
        def isatty(self) -> bool:
            return True

    monkeypatch.setattr("sys.stdin", _Fake())
    monkeypatch.setattr("builtins.input", lambda _prompt="": "2")
    msgs: list[str] = []
    choice = select_service_interactive(orgs, msgs.append)
    assert choice is not None
    assert choice.service.slug == "dev-us"


def test_select_service_interactive_rejects_invalid_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    orgs = [_org_obj()]

    class _Fake:
        def isatty(self) -> bool:
            return True

    monkeypatch.setattr("sys.stdin", _Fake())
    monkeypatch.setattr("builtins.input", lambda _prompt="": "99")
    msgs: list[str] = []
    choice = select_service_interactive(orgs, msgs.append)
    assert choice is None
    assert any("Invalid selection" in m for m in msgs)


# ---------- service_claim flow ----------


def test_run_claim_when_eligible_polls_until_running(
    isolated_home: Path, httpx_mock: HTTPXMock, tmp_path: Path
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/instanceClaimStatus",
        json={"eligible": True},
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/claimInstance",
        json={"outcome": "claimed", "id": "svc-1", "slug": "new-instance"},
    )
    # First get: still provisioning. Second: running.
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/get",
        json=_service(name="new-instance", slug="new-instance", status="provisioning"),
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/get",
        json=_service(name="new-instance", slug="new-instance", status="running"),
    )

    config_path = tmp_path / "clickhouse.config.py"
    config_path.write_text("# x", encoding="utf-8")
    msgs: list[object] = []
    code = run_claim(
        _creds(),
        config_path,
        msgs.append,
        json_mode=False,
    )
    assert code == 0
    assert any("Instance ready" in str(m) for m in msgs)


def test_run_claim_when_no_capacity_returns_1(
    isolated_home: Path, httpx_mock: HTTPXMock, tmp_path: Path
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/instanceClaimStatus",
        json={"eligible": True},
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/claimInstance",
        json={"outcome": "none_available"},
    )
    msgs: list[object] = []
    code = run_claim(_creds(), tmp_path / "config.py", msgs.append)
    assert code == 1
    assert any("No free dev instances" in str(m) for m in msgs)


def test_run_claim_when_provisioning_errors_returns_1(
    isolated_home: Path,
    httpx_mock: HTTPXMock,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/instanceClaimStatus",
        json={"eligible": True},
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/claimInstance",
        json={"outcome": "claimed", "id": "svc-1", "slug": "broken"},
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/get",
        json=_service(name="broken", slug="broken", status="error"),
    )

    monkeypatch.setattr(_service_claim_module.time, "sleep", lambda _: None)
    msgs: list[object] = []
    code = run_claim(_creds(), tmp_path / "config.py", msgs.append)
    assert code == 1


def test_run_claim_when_eligible_json_mode(
    isolated_home: Path, httpx_mock: HTTPXMock, tmp_path: Path
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/instanceClaimStatus",
        json={"eligible": True},
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/claimInstance",
        json={"outcome": "claimed", "id": "svc-1", "slug": "new"},
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/get",
        json=_service(name="new", slug="new", status="running"),
    )
    msgs: list[object] = []
    code = run_claim(_creds(), tmp_path / "config.py", msgs.append, json_mode=True)
    assert code == 0
    [envelope] = msgs
    assert isinstance(envelope, dict)
    assert envelope["ok"] is True
    assert envelope["status"] == "claimed"


# ---------- service command dispatch ----------


def test_service_list_subcommand_prints_organizations(
    isolated_home: Path, httpx_mock: HTTPXMock, tmp_path: Path
) -> None:
    save_credentials(_creds())
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/listAll",
        json={
            "organizations": [
                _org(
                    name="Org",
                    slug="org",
                    services=[_service(name="prod", slug="prod")],
                )
            ]
        },
    )

    config = ChxResolvedConfig(
        schema_=["./s.py"],
        out_dir="./chkit",
        migrations_dir="./chkit/m",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )
    runtime = load_plugin_runtime([obsessiondb()])
    msgs: list[object] = []
    ctx = ChxPluginCommandContext(
        plugin_name="obsessiondb",
        config=config,
        config_path=str(tmp_path / "config.py"),
        json_mode=False,
        args=["list"],
        flags={},
        options={},
        raw_options={},
        table_scope=TableScope(enabled=False),
        print=msgs.append,
        plugin_runtime=runtime,
        plugin_context=null_plugin_context(),
    )
    code = runtime.run_plugin_command("obsessiondb", "service", ctx)
    assert code == 0
    assert any("prod" in str(m) for m in msgs)


def test_service_command_returns_1_when_no_subcommand(
    isolated_home: Path, tmp_path: Path
) -> None:
    config = ChxResolvedConfig(
        schema_=["./s.py"],
        out_dir="./chkit",
        migrations_dir="./chkit/m",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )
    runtime = load_plugin_runtime([obsessiondb()])
    msgs: list[object] = []
    ctx = ChxPluginCommandContext(
        plugin_name="obsessiondb",
        config=config,
        config_path=str(tmp_path / "config.py"),
        json_mode=False,
        args=[],
        flags={},
        options={},
        raw_options={},
        table_scope=TableScope(enabled=False),
        print=msgs.append,
        plugin_runtime=runtime,
        plugin_context=null_plugin_context(),
    )
    code = runtime.run_plugin_command("obsessiondb", "service", ctx)
    assert code == 1
    assert any("Usage" in str(m) for m in msgs)


def test_service_alias_set_and_list_round_trip(
    isolated_home: Path, httpx_mock: HTTPXMock, tmp_path: Path
) -> None:
    save_credentials(_creds())
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/listAll",
        json={
            "organizations": [
                _org(
                    name="Org",
                    slug="org",
                    services=[_service(name="prod", slug="prod")],
                )
            ]
        },
    )

    config = ChxResolvedConfig(
        schema_=["./s.py"],
        out_dir="./chkit",
        migrations_dir="./chkit/m",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )
    runtime = load_plugin_runtime([obsessiondb()])

    def _ctx(args: list[str]) -> ChxPluginCommandContext:
        return ChxPluginCommandContext(
            plugin_name="obsessiondb",
            config=config,
            config_path=str(tmp_path / "config.py"),
            json_mode=False,
            args=args,
            flags={},
            options={},
            raw_options={},
            table_scope=TableScope(enabled=False),
            print=msgs.append,
            plugin_runtime=runtime,
            plugin_context=null_plugin_context(),
        )

    msgs: list[object] = []
    code = runtime.run_plugin_command(
        "obsessiondb", "service", _ctx(["alias", "set", "prod-alias", "prod"])
    )
    assert code == 0
    assert any("Saved alias" in str(m) for m in msgs)

    msgs.clear()
    code = runtime.run_plugin_command(
        "obsessiondb", "service", _ctx(["alias", "list"])
    )
    assert code == 0
    assert any("prod-alias" in str(m) for m in msgs)
