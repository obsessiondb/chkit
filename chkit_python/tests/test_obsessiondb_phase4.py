"""Tests for ObsessionDB Phase 4: workbench RPC, remote executor, backfill handler,
full onboarding wizard, and the ``ensure_obsessiondb_plugin_in_source`` text rewrite.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from pytest_httpx import HTTPXMock

from chkit.cli.table_scope import TableScope
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit.plugins import (
    ChxOnBeforePluginCommandContext,
    ChxOnBeforePluginCommandHandled,
    ChxOnBeforePluginCommandUnhandled,
)
from chkit_plugin_obsessiondb import (
    ConnectChoice,
    Credentials,
    RemoteClickHouseClient,
    connect_runbook_lines,
    create_remote_executor,
    ensure_obsessiondb_plugin_in_source,
    handle_backfill_command,
    jobs_cancel,
    jobs_get,
    jobs_list,
    normalize_query_data,
    normalize_query_json_result,
    run_onboarding,
    save_credentials,
    workbench_query_execute,
)
from chkit_plugin_obsessiondb import onboarding as obsessiondb_onboarding
from chkit_plugin_obsessiondb.workbench_api import (
    WorkbenchColumn,
    WorkbenchExecuteResult,
)

BASE = "https://api.test.obsessiondb.com"
SVC = "prod-eu"


def _config() -> ChxResolvedConfig:
    return ChxResolvedConfig(
        schema_=["./s.py"],
        out_dir="./chkit",
        migrations_dir="./chkit/m",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )


def _scope() -> TableScope:
    return TableScope(enabled=False)


@pytest.fixture
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg_dir = tmp_path / "xdg"
    cfg_dir.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_dir))
    monkeypatch.delenv("OBSESSIONDB_API_URL", raising=False)
    return cfg_dir


def _creds() -> Credentials:
    return Credentials(access_token="tok", base_url=BASE)


# ---------- workbench_api ----------


def test_workbench_query_execute_parses_result(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={
            "data": [[1, "a"], [2, "b"]],
            "meta": [{"name": "id", "type": "UInt64"}, {"name": "name", "type": "String"}],
            "rows": 2,
            "statistics": {"elapsed": 0.001},
            "query_id": "q-1",
        },
    )
    out = workbench_query_execute(_creds(), service_slug=SVC, query="SELECT id, name FROM t")
    assert isinstance(out, WorkbenchExecuteResult)
    assert out.rows == 2
    assert out.query_id == "q-1"


def test_workbench_query_execute_passes_settings(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={"data": [], "meta": [], "rows": 0},
    )
    workbench_query_execute(
        _creds(),
        service_slug=SVC,
        query="SELECT 1",
        settings={"query_id": "qid-x"},
    )


def test_workbench_query_execute_propagates_error(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={
            "data": [],
            "meta": [],
            "rows": 0,
            "error": "Syntax error",
        },
    )
    out = workbench_query_execute(_creds(), service_slug=SVC, query="BAD")
    assert out.error == "Syntax error"


# ---------- normalize_query_data ----------


def test_normalize_query_data_converts_list_rows_to_dicts() -> None:
    result = WorkbenchExecuteResult(
        data=[[1, "a"], [2, "b"]],
        meta=[WorkbenchColumn(name="id", type="UInt64"), WorkbenchColumn(name="name", type="String")],
        rows=2,
    )
    rows = normalize_query_data(result)
    assert rows == [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}]


def test_normalize_query_data_passes_through_dict_rows() -> None:
    result = WorkbenchExecuteResult(
        data=[{"id": 1, "name": "a"}],
        meta=[WorkbenchColumn(name="id", type="UInt64"), WorkbenchColumn(name="name", type="String")],
        rows=1,
    )
    rows = normalize_query_data(result)
    assert rows == [{"id": 1, "name": "a"}]


def test_normalize_query_json_result_wraps_envelope() -> None:
    result = WorkbenchExecuteResult(
        data=[[1]],
        meta=[WorkbenchColumn(name="id", type="UInt64")],
        rows=1,
        statistics={"elapsed": 0.5},
        query_id="q-42",
    )
    envelope = normalize_query_json_result(result)
    assert envelope.rows == 1
    assert envelope.query_id == "q-42"
    assert envelope.statistics == {"elapsed": 0.5}
    assert envelope.data == [{"id": 1}]


# ---------- RemoteClickHouseClient ----------


def test_remote_client_execute_raises_on_error_field(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={"data": [], "meta": [], "rows": 0, "error": "bad sql"},
    )
    client = create_remote_executor(_creds(), service_slug=SVC)
    with pytest.raises(RuntimeError, match="bad sql"):
        client.execute("DROP DATABASE foo")


def test_remote_client_query_returns_query_result(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={
            "data": [[1, "a"]],
            "meta": [{"name": "id", "type": "UInt64"}, {"name": "n", "type": "String"}],
            "rows": 1,
        },
    )
    client = create_remote_executor(_creds(), service_slug=SVC)
    out = client.query("SELECT 1")
    assert out.column_names == ["id", "n"]
    assert out.rows == [{"id": 1, "n": "a"}]


def test_remote_client_query_json_returns_envelope(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={
            "data": [[1]],
            "meta": [{"name": "id", "type": "UInt64"}],
            "rows": 1,
            "query_id": "q-1",
        },
    )
    client = create_remote_executor(_creds(), service_slug=SVC)
    out = client.query_json("SELECT 1")
    assert out.rows == 1
    assert out.query_id == "q-1"


def test_remote_client_submit_returns_passed_query_id(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={"data": [], "meta": [], "rows": 0},
    )
    client = create_remote_executor(_creds(), service_slug=SVC)
    qid = client.submit("ALTER TABLE x ADD COLUMN y UInt64", query_id="my-qid")
    assert qid == "my-qid"


def test_remote_client_query_status_returns_running(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={"data": [["my-qid"]], "meta": [{"name": "query_id", "type": "String"}], "rows": 1},
    )
    client = create_remote_executor(_creds(), service_slug=SVC)
    status = client.query_status("my-qid")
    assert status.status == "running"


def test_remote_client_query_status_finished_path(httpx_mock: HTTPXMock) -> None:
    # First call: empty system.processes
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={"data": [], "meta": [{"name": "query_id", "type": "String"}], "rows": 0},
    )
    # Second call: query_log row
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={
            "data": [["QueryFinish", "100", "8192", "500", ""]],
            "meta": [
                {"name": "type", "type": "String"},
                {"name": "written_rows", "type": "UInt64"},
                {"name": "written_bytes", "type": "UInt64"},
                {"name": "query_duration_ms", "type": "UInt64"},
                {"name": "exception", "type": "String"},
            ],
            "rows": 1,
        },
    )
    client = create_remote_executor(_creds(), service_slug=SVC)
    status = client.query_status("my-qid")
    assert status.status == "finished"
    assert status.written_rows == 100
    assert status.duration_ms == 500


def test_remote_client_query_status_unknown_when_log_empty(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={"data": [], "meta": [{"name": "query_id", "type": "String"}], "rows": 0},
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/workbench/query/execute",
        json={"data": [], "meta": [], "rows": 0},
    )
    client = create_remote_executor(_creds(), service_slug=SVC)
    status = client.query_status("my-qid")
    assert status.status == "unknown"


def test_remote_client_is_a_context_manager() -> None:
    with create_remote_executor(_creds(), service_slug=SVC) as client:
        assert isinstance(client, RemoteClickHouseClient)
        assert client.database == "default"


# ---------- jobs_api ----------


def test_jobs_get_parses_response(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/get",
        json={
            "id": "job-1",
            "service_slug": SVC,
            "status": "running",
        },
    )
    job = jobs_get(_creds(), job_id="job-1")
    assert job.id == "job-1"
    assert job.status == "running"


def test_jobs_list_parses_response(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/list",
        json={
            "jobs": [
                {"id": "j-1", "service_slug": SVC, "status": "pending"},
                {"id": "j-2", "service_slug": SVC, "status": "completed"},
            ]
        },
    )
    jobs = jobs_list(_creds(), service_slug=SVC)
    assert [j.id for j in jobs] == ["j-1", "j-2"]


def test_jobs_cancel_parses_response(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/cancel",
        json={"id": "job-1", "service_slug": SVC, "status": "cancelled"},
    )
    job = jobs_cancel(_creds(), job_id="job-1")
    assert job.status == "cancelled"


# ---------- backfill_handler ----------


def _bf_ctx(
    *,
    command: str,
    flags: dict[str, Any],
    target_plugin: str = "backfill",
    msgs: list[Any] | None = None,
) -> ChxOnBeforePluginCommandContext:
    return ChxOnBeforePluginCommandContext(
        target_plugin=target_plugin,
        command=command,
        config=_config(),
        config_path="cfg.py",
        json_mode=False,
        args=[],
        flags=flags,
        options={},
        table_scope=_scope(),
        print=(msgs.append if msgs is not None else lambda _v: None),
    )


def test_handler_skips_non_backfill_plugins(isolated_home: Path) -> None:
    result = handle_backfill_command(
        _bf_ctx(target_plugin="other", command="status", flags={})
    )
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


def test_handler_skips_when_local_flag_set(isolated_home: Path) -> None:
    result = handle_backfill_command(
        _bf_ctx(command="status", flags={"--local": True})
    )
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


def test_handler_skips_when_plan_id_set(isolated_home: Path) -> None:
    result = handle_backfill_command(
        _bf_ctx(command="status", flags={"--plan-id": "plan-1"})
    )
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


def test_handler_skips_unsupported_subcommand(isolated_home: Path) -> None:
    result = handle_backfill_command(_bf_ctx(command="plan", flags={}))
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


def test_handler_returns_unauthenticated_when_no_creds(
    isolated_home: Path,
) -> None:
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(command="status", flags={"--job-id": "j-1"}, msgs=msgs)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 1
    assert any("Not logged in" in str(m) for m in msgs)


def test_handler_status_with_job_id_calls_get(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(_creds())
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/get",
        json={"id": "j-1", "service_slug": SVC, "status": "completed"},
    )
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(command="status", flags={"--job-id": "j-1"}, msgs=msgs)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 0
    assert any("j-1" in str(m) for m in msgs)


def test_handler_status_with_service_slug_calls_list(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(_creds())
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/list",
        json={"jobs": [{"id": "j-1", "service_slug": SVC, "status": "pending"}]},
    )
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(command="status", flags={"--service-slug": SVC}, msgs=msgs)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 0


def test_handler_cancel_requires_job_id(
    isolated_home: Path,
) -> None:
    save_credentials(_creds())
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(command="cancel", flags={}, msgs=msgs)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 1
    assert any("--job-id is required" in str(m) for m in msgs)


def test_handler_list_requires_service_slug(
    isolated_home: Path,
) -> None:
    save_credentials(_creds())
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(command="list", flags={}, msgs=msgs)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 1
    assert any("--service-slug is required" in str(m) for m in msgs)


# ---------- onboarding (full wizard) ----------


def test_ensure_obsessiondb_plugin_in_source_adds_import_and_call() -> None:
    src = (
        '"""config"""\n'
        "from chkit import define_config\n"
        "\n"
        "config = define_config({\n"
        '    "schema": "./schema.py",\n'
        '    "outDir": "./chkit",\n'
        '    "migrationsDir": "./chkit/migrations",\n'
        '    "metaDir": "./chkit/meta",\n'
        '    "plugins": [],\n'
        "})\n"
    )
    out = ensure_obsessiondb_plugin_in_source(src)
    assert out.changed is True
    assert "from chkit_plugin_obsessiondb import obsessiondb" in out.source
    assert "obsessiondb()" in out.source


def test_ensure_obsessiondb_plugin_in_source_idempotent() -> None:
    src = (
        "from chkit_plugin_obsessiondb import obsessiondb\n"
        "x = [obsessiondb()]\n"
    )
    out = ensure_obsessiondb_plugin_in_source(src)
    assert out.changed is False
    assert out.source == src


def test_ensure_obsessiondb_plugin_in_source_returns_unchanged_when_no_plugins_block() -> None:
    src = "x = 1\n"
    out = ensure_obsessiondb_plugin_in_source(src)
    assert out.changed is False


def test_connect_runbook_lines_includes_three_paths() -> None:
    lines = connect_runbook_lines()
    joined = "\n".join(lines)
    assert "Free ObsessionDB dev instance" in joined
    assert "Existing ObsessionDB account" in joined
    assert "Existing ClickHouse instance" in joined


def test_run_onboarding_later_choice_prints_next_steps(
    isolated_home: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    run_onboarding(
        config_path=tmp_path / "config.py",
        connect=ConnectChoice.later,
    )
    out = capsys.readouterr().out
    assert "Next steps" in out


def test_run_onboarding_clickhouse_choice_prints_env_var_reminder(
    isolated_home: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cfg = tmp_path / "config.py"
    cfg.write_text(
        '"""x"""\n'
        "from chkit import define_config\n"
        'config = define_config({"schema": "./s.py", "outDir": "./chkit", '
        '"migrationsDir": "./chkit/m", "metaDir": "./chkit/meta", "plugins": []})\n',
        encoding="utf-8",
    )
    run_onboarding(
        config_path=cfg,
        connect=ConnectChoice.clickhouse,
    )
    out = capsys.readouterr().out
    assert "CLICKHOUSE_URL" in out
    assert "Next steps" in out


def test_run_onboarding_skip_skips_prompt(
    isolated_home: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    run_onboarding(config_path=tmp_path / "config.py", skip=True)
    out = capsys.readouterr().out
    assert "Next steps" in out


def test_run_onboarding_account_dispatches_to_login(
    isolated_home: Path,
    tmp_path: Path,
    httpx_mock: HTTPXMock,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Already-logged-in short-circuit so we don't open a browser.
    save_credentials(_creds())
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={"user": {"id": "u", "email": "a@b.com", "name": "A"}},
    )
    # Pin the resolve_base_url to our test BASE so the login URL matches the mock.
    monkeypatch.setattr(
        obsessiondb_onboarding, "resolve_base_url", lambda _stored=None: BASE
    )
    cfg = tmp_path / "config.py"
    cfg.write_text(
        'from chkit import define_config\nconfig = define_config({"schema": "./s.py", "outDir": "./chkit", "migrationsDir": "./chkit/m", "metaDir": "./chkit/meta", "plugins": []})\n',
        encoding="utf-8",
    )
    run_onboarding(config_path=cfg, connect=ConnectChoice.account)
    out = capsys.readouterr().out
    assert "Already logged in" in out
    assert "Next steps" in out


def test_run_onboarding_claim_path_signs_up_and_claims(
    isolated_home: Path,
    tmp_path: Path,
    httpx_mock: HTTPXMock,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        obsessiondb_onboarding, "resolve_base_url", lambda _stored=None: BASE
    )
    # signup: verify-otp returns token, get_session has no active org → create org
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/sign-in/email-otp",
        headers={"set-auth-token": "tok-x"},
        json={"user": {"id": "u", "email": "a@b.com", "name": "A"}},
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={"user": {"id": "u", "email": "a@b.com", "name": "A"}, "session": {}},
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/organization/create", json={"id": "org-1"}
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/organization/set-active", status_code=204
    )
    # claim flow
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/instanceClaimStatus",
        json={"eligible": True},
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/claimInstance",
        json={"outcome": "claimed", "id": "svc-1", "slug": "prod-eu"},
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/get",
        json={
            "id": "svc-1",
            "slug": "prod-eu",
            "name": "prod",
            "status": "running",
            "tier": 1,
            "nodes": 1,
            "connection_url": None,
            "connection_username": None,
            "desired_status": "running",
            "desired_tier": 1,
            "desired_nodes": 1,
            "created_at": "2026-01-01T00:00:00Z",
            "managed": True,
        },
    )

    cfg = tmp_path / "config.py"
    cfg.write_text(
        'from chkit import define_config\nconfig = define_config({"schema": "./s.py", "outDir": "./chkit", "migrationsDir": "./chkit/m", "metaDir": "./chkit/meta", "plugins": []})\n',
        encoding="utf-8",
    )
    run_onboarding(
        config_path=cfg,
        connect=ConnectChoice.claim,
        email="a@b.com",
        code="123456",
    )
    out = capsys.readouterr().out
    assert "Next steps" in out
    # The plugin was auto-registered.
    updated = cfg.read_text(encoding="utf-8")
    assert "obsessiondb()" in updated
