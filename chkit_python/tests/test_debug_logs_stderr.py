"""``CHKIT_DEBUG=1`` with ``--json``: stdout holds one JSON document, debug lines
go to stderr (#675). Twin of ``packages/cli/src/test/debug-logs-stderr.test.ts``.

Subprocesses, so CHKIT_DEBUG's logging setup stays out of this process.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

CONFIG = (
    'from chkit import define_config\n\nconfig = define_config({"schema": "./schema.py", '
    '"outDir": "./chkit"})\n'
)
SCHEMA = (
    "from chkit import table\n\n"
    "events = table(database='app', name='events', engine='MergeTree()', "
    "columns=[{'name': 'id', 'type': 'UInt64'}], primary_key=['id'], order_by=['id'])\n"
)


def run_cli(project: Path, *args: str) -> subprocess.CompletedProcess[str]:
    # An empty config home, so a user profile config cannot change the output.
    env = {**os.environ, "XDG_CONFIG_HOME": str(project / "xdg"), "CHKIT_DEBUG": "1"}
    return subprocess.run(
        [sys.executable, "-m", "chkit.cli.main", *args],
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_a_successful_command_prints_one_json_document(tmp_path: Path) -> None:
    (tmp_path / "clickhouse.config.py").write_text(CONFIG, encoding="utf-8")
    (tmp_path / "schema.py").write_text(SCHEMA, encoding="utf-8")

    result = run_cli(tmp_path, "generate", "--dryrun", "--json")

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["command"] == "generate"


def test_a_failing_command_prints_one_json_envelope_and_debug_on_stderr(
    tmp_path: Path,
) -> None:
    (tmp_path / "clickhouse.config.py").write_text("raise RuntimeError('boom')\n", encoding="utf-8")

    result = run_cli(tmp_path, "status", "--json")

    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["command"] == "status"
    assert "boom" in payload["error"]["message"]
    assert "[chkit.cli] fatal error" in result.stderr
