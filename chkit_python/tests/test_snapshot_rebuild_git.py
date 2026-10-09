"""Port of ``packages/cli/src/test/snapshot-rebuild-git.test.ts``.

``chkit snapshot rebuild`` on real git conflicts in a temporary repository: the
printed review commands run as pasted (through ``sh``) during a rebase and
during a merge, and the restore command brings back a committed snapshot over a
staged damaged one. Needs ``git`` on PATH; fails (never skips) without it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner, Result

from chkit.cli.main import app

REVIEW_COMMANDS = [
    "git diff HEAD -- chkit/meta/snapshot.json",
    "git diff MERGE_HEAD -- chkit/meta/snapshot.json    # during a merge",
    "git diff REBASE_HEAD -- chkit/meta/snapshot.json   # during a rebase",
]

EVENTS_TABLE = (
    'table(database="app", name="events", columns=[{"name": "id", "type": "UInt64"}, '
    '{"name": "source", "type": "String"}], engine="MergeTree()", primary_key=["id"], '
    'order_by=["id"])'
)

BRANCH_B_SCHEMA = """from chkit import schema, table, view

users = table(database="app", name="users", columns=[{"name": "id", "type": "UInt64"}], engine="MergeTree()", primary_key=["id"], order_by=["id"])
users_view = view(database="app", name="v_m2", as_="SELECT id FROM app.users")

definitions = schema(users, users_view)
"""


@dataclass(frozen=True)
class Proc:
    exit_code: int
    stdout: str
    stderr: str


@dataclass(frozen=True)
class GitProject:
    root: Path
    repo: Path
    config_path: Path
    run: Callable[[list[str]], Proc]

    @property
    def snapshot_path(self) -> Path:
        return self.repo / "chkit" / "meta" / "snapshot.json"

    def git(self, args: list[str]) -> Proc:
        return self.run(["git", *args])

    def git_ok(self, args: list[str]) -> str:
        result = self.git(args)
        assert result.exit_code == 0, f"git {' '.join(args)} failed:\n{result.stdout}\n{result.stderr}"
        return result.stdout

    def paste(self, line: str) -> Proc:
        """Run one printed command line through ``sh``, as pasting it into a terminal does."""
        return self.run(["sh", "-c", line])

    def chkit(self, args: list[str]) -> Result:
        return CliRunner().invoke(app, [*args, "--config", str(self.config_path)])

    def generate(self, name: str, migration_id: str) -> None:
        result = self.chkit(["generate", "--name", name, "--migration-id", migration_id, "--json"])
        assert result.exit_code == 0, f"generate {name} failed:\n{result.output}"


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> GitProject:
    git_path = shutil.which("git")
    assert git_path, "git is required on PATH"
    # Resolved, so the repo path matches the cwd the CLI sees (macOS tmp is a symlink).
    root = Path(os.path.realpath(tmp_path))
    repo = root / "repo"
    (repo / "src").mkdir(parents=True)
    (root / "gitconfig").write_text("", encoding="utf-8")
    config_path = repo / "clickhouse.config.py"
    config_path.write_text(
        "from chkit import define_config\n\n"
        f'config = define_config({{"schema": "{repo}/src/*.py", "outDir": "{repo}/chkit", '
        f'"migrationsDir": "{repo}/chkit/migrations", "metaDir": "{repo}/chkit/meta"}})\n',
        encoding="utf-8",
    )
    # Built from scratch: no user/system git config and no inherited GIT_DIR,
    # GIT_WORK_TREE or GIT_INDEX_FILE (e.g. when the suite runs from a git hook).
    git_env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(root),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": str(root / "gitconfig"),
        "GIT_AUTHOR_NAME": "chkit-test",
        "GIT_AUTHOR_EMAIL": "chkit-test@example.com",
        "GIT_COMMITTER_NAME": "chkit-test",
        "GIT_COMMITTER_EMAIL": "chkit-test@example.com",
        "GIT_EDITOR": "true",
        "GIT_TERMINAL_PROMPT": "0",
    }

    def run(cmd: list[str]) -> Proc:
        completed = subprocess.run(
            cmd, cwd=repo, env=git_env, capture_output=True, text=True, check=False
        )
        return Proc(completed.returncode, completed.stdout, completed.stderr)

    # Run chkit from the repo directory, like a user would, so printed paths are relative.
    monkeypatch.chdir(repo)
    created = GitProject(root=root, repo=repo, config_path=config_path, run=run)
    created.git_ok(["init", "-q", "-b", "main"])
    return created


def test_rebuilds_the_snapshot_a_rebase_left_conflicted_and_keeps_both_branches(
    project: GitProject,
) -> None:
    _commit_parallel_branches(project)

    # A merges first; B rebases onto it.
    project.git_ok(["checkout", "-q", "main"])
    project.git_ok(["merge", "-q", "--ff-only", "branch-a"])
    project.git_ok(["checkout", "-q", "branch-b"])
    rebase = project.git(["rebase", "main"])

    assert rebase.exit_code != 0
    assert "UU chkit/meta/snapshot.json" in project.git_ok(["status", "--porcelain"])
    assert "<<<<<<<" in project.snapshot_path.read_text(encoding="utf-8")
    # Neither side is complete: A's version lacks B's objects, B's has the old view SQL.
    ours = json.loads(project.git_ok(["show", ":2:chkit/meta/snapshot.json"]))
    theirs = json.loads(project.git_ok(["show", ":3:chkit/meta/snapshot.json"]))
    assert "table:app.users" not in _keys_of(ours)
    assert _view_sql(theirs, "v_events") == "SELECT id FROM app.events"

    preview = project.chkit(["snapshot", "rebuild", "--dryrun", "--json"])
    rebuild = project.chkit(["snapshot", "rebuild"])

    assert preview.exit_code == 0, preview.output
    preview_payload = json.loads(preview.stdout)
    assert preview_payload["written"] is False
    assert preview_payload["definitionCount"] == 5
    assert preview_payload["previous"] == {"status": "conflicted"}
    assert rebuild.exit_code == 0, rebuild.output
    assert "Rebuilt snapshot: " in rebuild.stdout
    commands = _printed_git_commands(rebuild.stdout)
    assert commands == REVIEW_COMMANDS
    # During a rebase, HEAD is main (with A) and REBASE_HEAD is B's commit being replayed.
    against_head = project.paste(commands[0])
    against_rebase_head = project.paste(_command_for(commands, "# during a rebase"))
    assert against_head.exit_code == 0
    assert '"name": "users"' in _changed_lines(against_head.stdout, "+")
    assert against_rebase_head.exit_code == 0, against_rebase_head.stderr
    assert '"as": "SELECT id FROM app.events"' in _changed_lines(against_rebase_head.stdout, "-")
    assert '"as": "SELECT id, source FROM app.events"' in _changed_lines(
        against_rebase_head.stdout, "+"
    )
    rebuilt = json.loads(project.snapshot_path.read_text(encoding="utf-8"))
    assert _keys_of(rebuilt) == [
        "table:app.events",
        "table:app.users",
        "view:app.v_events",
        "view:app.v_m1",
        "view:app.v_m2",
    ]
    assert _view_sql(rebuilt, "v_events") == "SELECT id, source FROM app.events"
    plan = project.chkit(["generate", "--dryrun", "--json"])
    assert plan.exit_code == 0, plan.output
    assert json.loads(plan.stdout)["operationCount"] == 0

    project.git_ok(["add", "chkit/meta/snapshot.json"])
    resumed = project.git(["rebase", "--continue"])
    assert resumed.exit_code == 0, resumed.stderr
    assert project.git_ok(["status", "--porcelain"]) == ""


def test_prints_review_commands_that_run_as_pasted_during_a_merge(project: GitProject) -> None:
    _commit_parallel_branches(project)

    # A merges first; B is merged into main afterwards.
    project.git_ok(["checkout", "-q", "main"])
    project.git_ok(["merge", "-q", "--ff-only", "branch-a"])
    merge = project.git(["merge", "--no-edit", "branch-b"])

    assert merge.exit_code != 0
    assert "UU chkit/meta/snapshot.json" in project.git_ok(["status", "--porcelain"])

    rebuild = project.chkit(["snapshot", "rebuild"])

    assert rebuild.exit_code == 0, rebuild.output
    commands = _printed_git_commands(rebuild.stdout)
    assert commands == REVIEW_COMMANDS
    against_head = project.paste(commands[0])
    against_merge_head = project.paste(_command_for(commands, "# during a merge"))
    # HEAD (main, with A) lacks B's objects.
    assert against_head.exit_code == 0
    assert '"name": "users"' in _changed_lines(against_head.stdout, "+")
    # MERGE_HEAD (B) still has the view SQL from before A changed it.
    assert against_merge_head.exit_code == 0, against_merge_head.stderr
    assert '"as": "SELECT id FROM app.events"' in _changed_lines(against_merge_head.stdout, "-")
    assert '"as": "SELECT id, source FROM app.events"' in _changed_lines(
        against_merge_head.stdout, "+"
    )


def test_prints_a_restore_command_that_brings_back_the_committed_snapshot(
    project: GitProject,
) -> None:
    (project.repo / "src" / "base.py").write_text(
        _base_schema("SELECT id FROM app.events"), encoding="utf-8"
    )
    project.generate("base", "20260101000000")
    project.git_ok(["add", "-A"])
    project.git_ok(["commit", "-q", "-m", "base"])
    committed = project.snapshot_path.read_text(encoding="utf-8")
    project.snapshot_path.write_text('{ "version": 1,', encoding="utf-8")
    project.git_ok(["add", "chkit/meta/snapshot.json"])

    rebuild = project.chkit(["snapshot", "rebuild"])

    assert rebuild.exit_code == 0, rebuild.output
    commands = _printed_git_commands(rebuild.stdout)
    assert commands == ["git checkout HEAD -- chkit/meta/snapshot.json"]
    # `git checkout -- <path>` would restore the staged damaged file from the index.
    restore = project.paste(commands[0])
    assert restore.exit_code == 0, restore.stderr
    assert project.snapshot_path.read_text(encoding="utf-8") == committed
    assert project.git_ok(["status", "--porcelain"]) == ""


def _commit_parallel_branches(project: GitProject) -> None:
    """main: a table and a view over it. branch-a changes the view and adds one;
    branch-b adds a table and a view."""
    src = project.repo / "src"
    (src / "base.py").write_text(_base_schema("SELECT id FROM app.events"), encoding="utf-8")
    project.generate("base", "20260101000000")
    project.git_ok(["add", "-A"])
    project.git_ok(["commit", "-q", "-m", "base"])

    project.git_ok(["checkout", "-q", "-b", "branch-a"])
    (src / "base.py").write_text(
        _base_schema("SELECT id, source FROM app.events", "v_m1"), encoding="utf-8"
    )
    project.generate("change_view", "20260102000000")
    project.git_ok(["add", "-A"])
    project.git_ok(["commit", "-q", "-m", "A: change view"])

    # Branch B starts from main and adds its objects in a separate schema file.
    project.git_ok(["checkout", "-q", "main"])
    project.git_ok(["checkout", "-q", "-b", "branch-b"])
    (src / "b.py").write_text(BRANCH_B_SCHEMA, encoding="utf-8")
    project.generate("add_users", "20260103000000")
    project.git_ok(["add", "-A"])
    project.git_ok(["commit", "-q", "-m", "B: add users"])


def _base_schema(events_view_sql: str, extra_view: str | None = None) -> str:
    extra = (
        f'\nextra = view(database="app", name="{extra_view}", as_="SELECT 1 AS one")\n'
        if extra_view
        else ""
    )
    exported = "events, events_view" + (", extra" if extra_view else "")
    return f"""from chkit import schema, table, view

events = {EVENTS_TABLE}
events_view = view(database="app", name="v_events", as_="{events_view_sql}")
{extra}
definitions = schema({exported})
"""


def _printed_git_commands(stdout: str) -> list[str]:
    """The indented ``git ...`` lines of chkit's text output, as a user would copy them."""
    return [line.strip() for line in stdout.split("\n") if line.startswith("  git ")]


def _command_for(commands: list[str], label: str) -> str:
    matches = [command for command in commands if command.endswith(label)]
    assert matches, f"no command labelled {label!r} in {commands}"
    return matches[0]


def _changed_lines(diff: str, marker: str) -> list[str]:
    """Added (+) or removed (-) lines of a unified diff, without marker, indentation and trailing comma."""
    return [
        line[1:].strip().removesuffix(",")
        for line in diff.split("\n")
        if line.startswith(marker) and not line.startswith(marker * 3)
    ]


def _keys_of(snapshot: dict[str, Any]) -> list[str]:
    return [f"{d['kind']}:{d['database']}.{d['name']}" for d in snapshot["definitions"]]


def _view_sql(snapshot: dict[str, Any], name: str) -> str | None:
    for definition in snapshot["definitions"]:
        if definition["kind"] == "view" and definition["name"] == name:
            value = definition.get("as")
            return value if isinstance(value, str) else None
    return None
