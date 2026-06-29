"""End-to-end test for the codegen-after-generate integration.

When the user's ``clickhouse.config.py`` registers ``codegen()`` in its plugin
list, running ``chkit generate`` should auto-invoke the codegen plugin and
emit the generated Pydantic models file.

Setting ``runOnGenerate: False`` in the codegen options should opt-out.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app

CONFIG_WITH_CODEGEN = """\
from chkit import define_config
from chkit_plugin_codegen import codegen

config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "plugins": [codegen({"outFile": "./generated/models.py"})],
    }
)
"""

CONFIG_WITH_CODEGEN_OPTED_OUT = """\
from chkit import define_config
from chkit_plugin_codegen import codegen

config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "plugins": [codegen({"outFile": "./generated/models.py", "runOnGenerate": False})],
    }
)
"""

SCHEMA = """\
from chkit import ColumnDefinition, schema, table

events = table(
    database="default",
    name="events",
    engine="MergeTree",
    columns=[
        ColumnDefinition(name="id", type="UInt64"),
        ColumnDefinition(name="payload", type="String"),
    ],
    primary_key=["id"],
    order_by=["id"],
)

definitions = schema(events)
"""


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


def _write_project(tmp_path: Path, config_src: str) -> None:
    (tmp_path / "clickhouse.config.py").write_text(config_src, encoding="utf-8")
    (tmp_path / "schema.py").write_text(SCHEMA, encoding="utf-8")
    (tmp_path / "chkit").mkdir()
    (tmp_path / "chkit" / "migrations").mkdir()
    (tmp_path / "chkit" / "meta").mkdir()


def test_generate_runs_codegen_integration(
    runner: CliRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_project(tmp_path, CONFIG_WITH_CODEGEN)
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(
        app,
        ["generate", "--name", "init"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0, result.output
    generated = tmp_path / "generated" / "models.py"
    assert generated.exists(), "codegen integration did not write the output file"
    content = generated.read_text(encoding="utf-8")
    assert "class DefaultEventsRow(BaseModel):" in content
    assert "id: int" in content
    assert "payload: str" in content


def test_generate_skips_codegen_when_run_on_generate_false(
    runner: CliRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_project(tmp_path, CONFIG_WITH_CODEGEN_OPTED_OUT)
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(
        app,
        ["generate", "--name", "init"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0, result.output
    generated = tmp_path / "generated" / "models.py"
    assert not generated.exists(), "codegen should have been skipped"
