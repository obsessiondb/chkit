"""``chkit plugin <name> <command>`` connects to the ``clickhouse`` block only
when the command sends SQL through its default executor, as in TS, where
``createClickHouseExecutor`` opens no connection until the first query.

A command that a plugin's ``get_context`` gives its own executor, or one that
sends no SQL, never connects to the ``clickhouse`` block, so an unreachable or
slow server there does not hold it up. A local listener counts the
connections made to the configured URL.
"""

from __future__ import annotations

import json
import socket
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands.plugin import _LazyClickHouseClient
from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import resolve_live_env

PROBE_PLUGIN = '''
import json
from pathlib import Path

from chkit.plugins import ChxPlugin, ChxPluginCommand, ChxPluginManifest, PluginContext


class _OwnExecutor:
    def close(self):
        pass


class _Hooks:
    def get_context(self, ctx):
        if ctx.command == "own":
            return PluginContext(executor=_OwnExecutor(), has_executor=True)
        return None


def _own(ctx):
    Path("ran.json").write_text(json.dumps(type(ctx.plugin_context.executor).__name__))


def _nosql(ctx):
    Path("ran.json").write_text(json.dumps(ctx.plugin_context.has_executor))


def _sql(ctx):
    rows = ctx.plugin_context.executor.query("SELECT 41 + 1 AS answer").rows
    Path("ran.json").write_text(json.dumps(rows))


def probe():
    return ChxPlugin(
        manifest=ChxPluginManifest(name="probe"),
        hooks=_Hooks(),
        commands=[
            ChxPluginCommand(name="own", run=_own),
            ChxPluginCommand(name="nosql", run=_nosql),
            ChxPluginCommand(name="sql", run=_sql),
        ],
    )
'''

CONFIG = """
from chkit import define_config
from lazy_connect_probe import probe

config = define_config({{
    "schema": "./schema.py",
    "outDir": "./chkit",
    "clickhouse": {{"url": {url!r}, "username": {user!r}, "password": {password!r}, "database": {database!r}}},
    "plugins": [probe()],
}})
"""


class _Listener:
    """Accepts connections and closes them unanswered, counting each one."""

    def __init__(self) -> None:
        self._socket = socket.socket()
        self._socket.bind(("127.0.0.1", 0))
        self._socket.listen(16)
        self.port: int = self._socket.getsockname()[1]
        self.connections = 0
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self._socket.accept()
            except OSError:
                return
            self.connections += 1
            conn.close()

    def close(self) -> None:
        self._socket.close()


@pytest.fixture
def listener() -> Iterator[_Listener]:
    server = _Listener()
    yield server
    server.close()


def _project(
    root: Path, monkeypatch: pytest.MonkeyPatch, *, url: str, user: str, password: str, database: str
) -> Path:
    monkeypatch.chdir(root)
    monkeypatch.syspath_prepend(str(root))
    # Its own module name: other tests import other probe modules.
    (root / "lazy_connect_probe.py").write_text(PROBE_PLUGIN, encoding="utf-8")
    (root / "schema.py").write_text(
        "from chkit import schema\n\ndefinitions = schema()\n", encoding="utf-8"
    )
    (root / "clickhouse.config.py").write_text(
        CONFIG.format(url=url, user=user, password=password, database=database),
        encoding="utf-8",
    )
    return root


def _ran(root: Path) -> Any:
    return json.loads((root / "ran.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("args", [["plugin", "probe", "own"], ["plugin", "probe", "nosql"]])
def test_plugin_command_without_default_sql_never_connects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, listener: _Listener, args: list[str]
) -> None:
    root = _project(
        tmp_path,
        monkeypatch,
        url=f"http://127.0.0.1:{listener.port}",
        user="default",
        password="",
        database="default",
    )

    result = CliRunner().invoke(app, args)

    assert result.exit_code == 0, result.output
    # `own` gets the plugin's executor; `nosql` still has the default one.
    assert _ran(root) == ("_OwnExecutor" if args[-1] == "own" else True)
    assert listener.connections == 0


def test_plugin_command_sends_sql_through_the_default_executor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    root = _project(
        tmp_path,
        monkeypatch,
        url=env.clickhouse_url,
        user=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
    )

    result = CliRunner().invoke(app, ["plugin", "probe", "sql"])

    assert result.exit_code == 0, result.output
    assert _ran(root) == [{"answer": 42}]


class _FakeClient:
    def __init__(self) -> None:
        self.closed = 0

    def query(self, statement: str) -> str:
        return f"ran {statement}"

    def close(self) -> None:
        self.closed += 1


@pytest.fixture
def connects(monkeypatch: pytest.MonkeyPatch) -> list[_FakeClient]:
    """Each client the default executor opens, in place of a real connection."""
    opened: list[_FakeClient] = []

    def connect(cls: object, config: object) -> _FakeClient:
        opened.append(_FakeClient())
        return opened[-1]

    monkeypatch.setattr(ClickHouseClient, "connect", classmethod(connect))
    return opened


def _default_executor() -> Any:
    return _LazyClickHouseClient(
        ChxResolvedClickHouseConfig(
            url="http://127.0.0.1:9", database="app", cluster="c1", username="default", password="", secure=False
        )
    )


def test_default_executor_reads_its_configuration_without_connecting(
    connects: list[_FakeClient],
) -> None:
    executor = _default_executor()

    assert executor.database == "app"
    assert executor.query_control_cluster == "c1"
    assert hasattr(executor, "submit")
    assert not hasattr(executor, "no_such_method")
    executor.close()

    assert connects == []


def test_default_executor_connects_once_and_not_after_close(
    connects: list[_FakeClient],
) -> None:
    executor = _default_executor()

    assert executor.query("SELECT 1") == "ran SELECT 1"
    assert executor.query("SELECT 2") == "ran SELECT 2"
    executor.close()
    executor.close()
    with pytest.raises(RuntimeError, match="closed"):
        executor.query("SELECT 3")

    assert len(connects) == 1
    assert connects[0].closed == 1
