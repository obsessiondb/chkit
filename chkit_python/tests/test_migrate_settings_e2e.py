"""Port of ``packages/cli/src/test/migrate-settings.e2e.test.ts`` (#321).

``migrate --setting`` sends ClickHouse settings with every migration
statement: a 1-byte ``max_table_size_to_drop`` makes the server refuse a DROP,
and 0 lets the resumed run drop the table. The DROP's before-retry SQL, an async
INSERT and a barrier read a unique ``log_comment`` back with ``getSetting()``,
and a run without ``--setting`` sends none.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest
from clickhouse_connect.driver.exceptions import (  # type: ignore[import-untyped]
    DatabaseError,
)
from typer.testing import CliRunner

from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_settings import (
    assert_insert_settings_changeable,
    insert_settings_override_warning,
    merge_migration_settings,
    parse_setting_flags,
)
from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.insert_settings import insert_settings_from_url
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
    wait_for_table_on_every_replica,
)

# ObsessionDB users cannot create a settings profile (#430).
_ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"


@pytest.fixture
def live() -> Iterator[ClickHouseClient]:
    env = resolve_live_env()
    with ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    ) as client:
        yield client


def test_parse_setting_flags() -> None:
    assert parse_setting_flags(None) is None
    assert parse_setting_flags([]) is None
    assert parse_setting_flags(
        ["max_table_size_to_drop=0,max_partition_size_to_drop = 0", "log_comment=a=b"]
    ) == {
        "max_table_size_to_drop": "0",
        "max_partition_size_to_drop": "0",
        "log_comment": "a=b",
    }
    for entry in ["max_table_size_to_drop", "=0", "bad-name=0"]:
        with pytest.raises(MigrateError, match="--setting expects <name>=<value>"):
            parse_setting_flags([entry])
    for name in [
        "query",
        "database",
        "query_id",
        "session_id",
        "session_check",
        "session_timeout",
        "user",
        "password",
    ]:
        with pytest.raises(
            MigrateError, match=f"--setting {name} is not allowed"
        ) as error:
            parse_setting_flags([f"max_table_size_to_drop=0,{name}=secret"])
        assert "secret" not in str(error.value)


def test_parse_setting_flags_keeps_insert_settings_and_profile_as_written() -> None:
    # #790, as TS settings.test.ts.
    assert parse_setting_flags(["async_insert=TRUE,wait_for_async_insert = 0", "profile=bulk"]) == {
        "async_insert": "TRUE",
        "wait_for_async_insert": "0",
        "profile": "bulk",
    }


def test_insert_settings_override_warning() -> None:
    # #790, as TS settings.test.ts: nothing for chkit's defaults in any
    # spelling, one line naming each other value as written.
    assert insert_settings_override_warning(None) is None
    assert insert_settings_override_warning({"max_threads": "1", "profile": "bulk"}) is None
    assert insert_settings_override_warning(
        {"async_insert": "FALSE", "wait_for_async_insert": "1"}
    ) is None
    assert insert_settings_override_warning(
        {"async_insert": "0", "wait_for_async_insert": "true"}
    ) is None
    assert insert_settings_override_warning({"async_insert": "True"}) == (
        "Warning: --setting overrides what every migration write sets by default: "
        "async_insert=True (an INSERT is queued as an asynchronous insert, which migrate "
        "cannot cancel)."
    )
    assert insert_settings_override_warning(
        {"wait_for_async_insert": "0", "async_insert": "1"}
    ) == (
        "Warning: --setting overrides what every migration write sets by default: "
        "async_insert=1 (an INSERT is queued as an asynchronous insert, which migrate "
        "cannot cancel); wait_for_async_insert=0 (an asynchronous INSERT can be journaled "
        "as applied before its rows are stored)."
    )


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "http://localhost/?ch_async_insert=1&clickhouse_setting_wait_for_async_insert=0",
            {"async_insert": "1", "wait_for_async_insert": "0"},
        ),
        (
            "http://localhost/?clickhouse_setting_async_insert=0&"
            "ch_async_insert=TRUE&ch_wait_for_async_insert",
            {"async_insert": "TRUE", "wait_for_async_insert": ""},
        ),
        (
            "http://localhost/?ch_async_insert=0&ch_async_insert=1&clickhouse_setting_async_insert=1",
            {"async_insert": "1"},
        ),
        (
            "http://localhost/?clickhouse_setting_async_insert=1&clickhouse_setting_async_insert=0",
            {"async_insert": "0"},
        ),
        (
            "http://localhost/?ch_async_insert=1&ch_wait_for_async_insert=0&"
            "clickhouse_setting_wait_for_async_insert=1&ch_wait_for_async_insert=1",
            {"async_insert": "1", "wait_for_async_insert": "1"},
        ),
        (" http://localhost/?ch_async_insert=0\t \n", {"async_insert": "0"}),
        ("http://localhost/?ch_async_insert=%201+", {"async_insert": " 1 "}),
        ("http://localhost/?ch_max_threads=4&async_insert=1", None),
        ("http://localhost/", None),
        ("http://[broken/?ch_async_insert=1", None),
        ("http://localhost:bad/?ch_async_insert=1", None),
    ],
)
def test_insert_settings_from_url(url: str, expected: dict[str, str] | None) -> None:
    assert insert_settings_from_url(url) == expected


def test_url_insert_settings_override_warning() -> None:
    async_guarantee = "an INSERT is queued as an asynchronous insert, which migrate cannot cancel"
    wait_guarantee = "an asynchronous INSERT can be journaled as applied before its rows are stored"
    assert insert_settings_override_warning(None, {"async_insert": "1"}) == (
        "Warning: clickhouse.url overrides what every migration write sets by default: "
        f"async_insert=1 ({async_guarantee})."
    )
    assert insert_settings_override_warning({"async_insert": "1"}, {"wait_for_async_insert": "0"}) == (
        "Warning: --setting and clickhouse.url override what every migration write sets by default: "
        f"async_insert=1 from --setting ({async_guarantee}); "
        f"wait_for_async_insert=0 from clickhouse.url ({wait_guarantee})."
    )
    assert insert_settings_override_warning({"async_insert": "0"}, {"async_insert": "1"}) is None


def test_merge_migration_settings() -> None:
    assert merge_migration_settings(
        {"async_insert": "0", "profile": "bulk"},
        {"async_insert": "1", "wait_for_async_insert": "0"},
    ) == {"async_insert": "0", "wait_for_async_insert": "0", "profile": "bulk"}
    assert merge_migration_settings(None, None) is None


def test_migrate_sends_settings_with_every_statement(
    live: ClickHouseClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    db = live.database
    prefix = create_prefix("setting_py")
    table = f"{prefix}big"
    sink = f"{prefix}sink"
    journal_table = create_journal_table_name("setting_py")
    fqn = f"{quote_ident(db)}.{quote_ident(table)}"
    sink_fqn = f"{quote_ident(db)}.{quote_ident(sink)}"
    # A unique log_comment the statements read back with getSetting().
    tag = prefix

    def unset_check(step: str) -> str:
        return (
            f"throwIf(getSetting('log_comment') != '{tag}', "
            f"'--setting log_comment is not set for the {step}')"
        )

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")

    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\nconfig = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "outDir": "./chkit",
            "migrationsDir": "./chkit/migrations",
            "metaDir": "./chkit/meta",
            "clickhouse": {
                "url": env.clickhouse_url,
                "username": env.clickhouse_user,
                "password": env.clickhouse_password,
                "database": db,
            },
        })
        + ")\n"
    )
    migrations = tmp_path / "chkit" / "migrations"
    migrations.mkdir(parents=True)
    # A sync DROP with a before-retry guard, an async INSERT and a barrier,
    # each of which reads the settings it was sent.
    (migrations / "20990101000000_drop_big.sql").write_text(
        f"-- operation: drop_table key=table:{db}.{table} risk=danger\n"
        f"-- before-retry: SELECT {unset_check('before-retry SQL')}\n"
        f"DROP TABLE IF EXISTS {fqn};\n"
        f"-- operation: load_table_data key=table:{db}.{sink} risk=caution mode=async\n"
        f"INSERT INTO {sink_fqn} SELECT getSetting('log_comment');\n"
        f"-- operation: cutover_wait_for_inserts key=table:{db}.{sink}:cutover:mirror_barrier "
        "risk=safe mode=barrier\n"
        f"SELECT query_id FROM system.processes WHERE {unset_check('barrier')} = 1 "
        "OR query_kind IN ('Insert', 'AsyncInsertFlush');\n"
    )

    def migrate(*settings: str) -> Any:
        flags = [arg for setting in settings for arg in ("--setting", setting)]
        return CliRunner().invoke(app, ["migrate", "--apply", "--allow-destructive", *flags])

    def count(sql: str) -> int:
        return int(live.query(sql).rows[0]["n"])

    try:
        live.execute(f"CREATE TABLE {fqn} (id UInt64) ENGINE = MergeTree ORDER BY id")
        wait_for_table_on_every_replica(live, db, table)
        live.execute(f"INSERT INTO {fqn} SELECT number FROM numbers(1000)")
        live.execute(f"CREATE TABLE {sink_fqn} (comment String) ENGINE = MergeTree ORDER BY comment")
        wait_for_table_on_every_replica(live, db, sink)

        # A 1-byte limit makes the server refuse the drop: the setting reached it.
        refused = migrate("max_table_size_to_drop=1", f"log_comment={tag}")
        assert refused.exit_code != 0, format_test_diagnostic("drop was not refused", refused)
        assert "max_[table/partition]_size_to_drop" in refused.output, refused.output
        assert count(f"SELECT count() AS n FROM {fqn}") == 1000

        # Without --setting no setting is sent: the before-retry guard of the
        # failed DROP finds log_comment unset and stops the run.
        unset = migrate()
        assert unset.exit_code != 0, format_test_diagnostic("guard did not stop the run", unset)
        assert "--setting log_comment is not set for the before-retry SQL" in unset.output, (
            unset.output
        )
        assert count(f"SELECT count() AS n FROM {fqn}") == 1000

        # 0 lifts the limit: the run resumes at the DROP, and the before-retry
        # SQL, the async INSERT and the barrier all see the settings.
        applied = migrate("max_table_size_to_drop=0", f"log_comment={tag}")
        assert applied.exit_code == 0, format_test_diagnostic("migrate --apply failed", applied)
        remaining = count(
            f"SELECT count() AS n FROM system.tables WHERE database = '{db}' AND name = '{table}'"
        )
        assert remaining == 0
        written = live.query(f"SELECT comment FROM {sink_fqn}").rows
        assert written == [{"comment": tag}]
    finally:
        live.execute(f"DROP TABLE IF EXISTS {fqn} SYNC", {"max_table_size_to_drop": 0})
        live.execute(f"DROP TABLE IF EXISTS {sink_fqn} SYNC")
        live.execute(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)} SYNC")


@pytest.mark.skipif(_ON_OBSESSIONDB, reason="ObsessionDB users have no CREATE USER grant (#430)")
def test_insert_setting_overrides_are_sent_as_written_after_a_profile_with_one_warning(  # noqa: PLR0915
    live: ClickHouseClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#790, as TS migrate-settings.e2e.test.ts: async_insert and
    wait_for_async_insert are defaults --setting may override, used as written
    on sync and async statements with one warning, and sent after a --setting
    profile, so the profile cannot change them."""
    env = resolve_live_env()
    db = live.database
    prefix = create_prefix("insert_override_py")
    sink = f"{prefix}sink"
    profile = f"{prefix}fire_and_forget"
    sink_fqn = f"{quote_ident(db)}.{quote_ident(sink)}"
    journal_table = create_journal_table_name("insert_override_py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")

    def write_config(url: str) -> None:
        (tmp_path / "clickhouse.config.py").write_text(
            "from chkit import define_config\n\nconfig = define_config("
            + json.dumps({
                "schema": "./schema.py",
                "outDir": "./chkit",
                "migrationsDir": "./chkit/migrations",
                "metaDir": "./chkit/meta",
                "clickhouse": {
                    "url": url,
                    "username": env.clickhouse_user,
                    "password": env.clickhouse_password,
                    "database": db,
                },
            })
            + ")\n"
        )

    migrations = tmp_path / "chkit" / "migrations"
    migrations.mkdir(parents=True)

    def write_migration(name: str, first: int) -> None:
        (migrations / name).write_text(
            f"INSERT INTO {sink_fqn} VALUES ({first});\n"
            f"-- operation: load_table_data key=table:{db}.{sink} risk=caution mode=async\n"
            f"INSERT INTO {sink_fqn} SELECT {first + 1};\n"
        )

    def migrate(*settings: str, json_mode: bool = False) -> Any:
        flags = [arg for setting in settings for arg in ("--setting", setting)]
        return CliRunner().invoke(
            app, ["migrate", "--apply", *flags, *(["--json"] if json_mode else [])]
        )

    def stored() -> int:
        return int(live.query(f"SELECT toString(count()) AS n FROM {sink_fqn}").rows[0]["n"])

    def sent_settings(tag: str | None = None) -> list[dict[str, Any]]:
        live.execute("SYSTEM FLUSH LOGS")

        # Settings lists a setting only when its value is not the server's default.
        def effective(name: str) -> str:
            return (
                f"if(mapContains(Settings, '{name}'), Settings['{name}'], "
                f"(SELECT default FROM system.settings WHERE name = '{name}')) AS {name}"
            )

        target = (
            f"has(tables, '{db}.{journal_table}')" if tag is None else
            f"Settings['log_comment'] = '{tag}' AND has(tables, '{db}.{sink}')"
        )
        return list(live.query(
            f"SELECT {effective('async_insert')}, {effective('wait_for_async_insert')} "
            "FROM system.query_log WHERE type = 'QueryFinish' AND query_kind = 'Insert' "
            f"AND {target}"
        ).rows)

    def warnings(stderr: str) -> list[str]:
        return [
            line for line in stderr.splitlines()
            if line.startswith("Warning: ") and "what every migration write sets by default" in line
        ]

    try:
        write_config(env.clickhouse_url)
        # Fire-and-forget: without chkit's settings after it, an INSERT would
        # return with its rows still buffered for 3 s.
        live.execute(
            f"CREATE SETTINGS PROFILE {quote_ident(profile)} SETTINGS async_insert = 1, "
            "wait_for_async_insert = 0, async_insert_use_adaptive_busy_timeout = 0, "
            "async_insert_busy_timeout_max_ms = 3000"
        )
        live.execute(f"CREATE TABLE {sink_fqn} (id UInt64) ENGINE = MergeTree ORDER BY id")
        wait_for_table_on_every_replica(live, db, sink)

        # A profile, and async_insert at chkit's default in another spelling:
        # no warning, and both statements are stored when the run exits.
        write_migration("20990101000000_first.sql", 1)
        profiled = migrate(f"log_comment={prefix}a", f"profile={profile}", "async_insert=FALSE")
        assert profiled.exit_code == 0, format_test_diagnostic("migrate with a profile", profiled)
        assert warnings(profiled.stderr) == []
        assert stored() == 2
        assert sent_settings(f"{prefix}a") == [
            {"async_insert": "0", "wait_for_async_insert": "1"},
        ] * 2

        # An override is used as written on both statements, with one warning.
        write_migration("20990101000001_second.sql", 3)
        overridden = migrate(f"log_comment={prefix}b", "async_insert=true")
        assert overridden.exit_code == 0, format_test_diagnostic(
            "migrate with an override", overridden
        )
        assert warnings(overridden.stderr) == [
            "Warning: --setting overrides what every migration write sets by default: "
            "async_insert=true (an INSERT is queued as an asynchronous insert, which migrate "
            "cannot cancel).",
        ]
        assert stored() == 4
        assert sent_settings(f"{prefix}b") == [
            {"async_insert": "1", "wait_for_async_insert": "1"},
        ] * 2

        # #879: a URL override follows the profile too. Journal writes stay durable.
        url = urlsplit(env.clickhouse_url)
        query = "&".join(filter(None, [url.query, "ch_async_insert=1"]))
        write_config(url._replace(query=query).geturl())
        write_migration("20990101000002_url.sql", 5)
        from_url = migrate(f"log_comment={prefix}c", f"profile={profile}", json_mode=True)
        assert from_url.exit_code == 0, format_test_diagnostic("migrate with a URL override", from_url)
        assert warnings(from_url.stderr) == [
            "Warning: clickhouse.url overrides what every migration write sets by default: "
            "async_insert=1 (an INSERT is queued as an asynchronous insert, which migrate "
            "cannot cancel).",
        ]
        assert stored() == 6
        assert sent_settings(f"{prefix}c") == [
            {"async_insert": "1", "wait_for_async_insert": "1"},
        ] * 2

        write_migration("20990101000003_flag_wins.sql", 7)
        flag_wins = migrate(f"log_comment={prefix}d", f"profile={profile}", "async_insert=0")
        assert flag_wins.exit_code == 0, format_test_diagnostic(
            "migrate with a flag and URL", flag_wins
        )
        assert warnings(flag_wins.stderr) == []
        assert stored() == 8
        assert sent_settings(f"{prefix}d") == [
            {"async_insert": "0", "wait_for_async_insert": "1"},
        ] * 2
        journal_settings = sent_settings()
        assert journal_settings
        assert journal_settings == [
            {"async_insert": "0", "wait_for_async_insert": "1"},
        ] * len(journal_settings)
    finally:
        live.execute(f"DROP TABLE IF EXISTS {sink_fqn} SYNC")
        live.execute(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)} SYNC")
        live.execute(f"DROP SETTINGS PROFILE IF EXISTS {quote_ident(profile)}")


class _SettingsClient:
    def __init__(self, rows: list[dict[str, object]] | Exception) -> None:
        self._rows = rows

    def query(self, _sql: str) -> object:
        if isinstance(self._rows, Exception):
            raise self._rows
        return type("Result", (), {"rows": self._rows})()


_CHANGEABLE: list[dict[str, object]] = [
    {"name": "readonly", "value": "0", "readonly": 0},
    {"name": "async_insert", "value": "1", "readonly": 0},
    {"name": "wait_for_async_insert", "value": "0", "readonly": 0},
]


def test_insert_settings_check_passes_changeable_matching_and_readonly_users() -> None:
    # #790, as TS settings.test.ts.
    for rows in [
        _CHANGEABLE,
        [{"name": "async_insert", "value": "0", "readonly": 1},
         {"name": "wait_for_async_insert", "value": "1", "readonly": 1}],
        [{"name": "readonly", "value": "1", "readonly": 1},
         {"name": "async_insert", "value": "1", "readonly": 1}],
    ]:
        assert_insert_settings_changeable(_SettingsClient(rows))  # type: ignore[arg-type]


def test_insert_settings_check_stops_the_run_when_it_cannot_read() -> None:
    # As TS: a failed read stops the run, unless the database does not exist yet.
    with pytest.raises(DatabaseError, match="denied"):
        assert_insert_settings_changeable(_SettingsClient(DatabaseError("denied")))  # type: ignore[arg-type]
    missing = DatabaseError("Code: 81. DB::Exception: Database x does not exist. (UNKNOWN_DATABASE)")
    assert_insert_settings_changeable(_SettingsClient(missing))  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("name", "value", "durable"),
    [("async_insert", "1", "0"), ("wait_for_async_insert", "0", "1")],
)
def test_insert_settings_fixed_elsewhere_are_refused(name: str, value: str, durable: str) -> None:
    rows = [
        {"name": name, "value": value, "readonly": 1} if row["name"] == name else row
        for row in _CHANGEABLE
    ]
    with pytest.raises(MigrateError) as error:
        assert_insert_settings_changeable(_SettingsClient(rows))  # type: ignore[arg-type]
    assert error.value.code == "insert_settings_fixed"
    assert str(error.value) == (
        f"Setting {name} is fixed at {value} for this ClickHouse user, and chkit migrate "
        f"needs {name} = {durable} so that a statement it records as applied is stored. "
        "Nothing ran."
    )


def test_insert_settings_check_uses_the_value_sent() -> None:
    # #790, as TS settings.test.ts: an override is checked as sent, and
    # chkit's default as its journal writes send it.
    def fixed_at(name: str, value: str) -> list[dict[str, object]]:
        return [
            {"name": name, "value": value, "readonly": 1} if row["name"] == name else row
            for row in _CHANGEABLE
        ]

    assert_insert_settings_changeable(
        _SettingsClient(fixed_at("async_insert", "0")),  # type: ignore[arg-type]
        {"async_insert": "false"},
    )
    with pytest.raises(MigrateError) as error:
        assert_insert_settings_changeable(
            _SettingsClient(fixed_at("async_insert", "0")),  # type: ignore[arg-type]
            {"async_insert": "1"},
        )
    assert error.value.code == "insert_settings_fixed"
    assert str(error.value) == (
        "Setting async_insert is fixed at 0 for this ClickHouse user, so "
        "--setting async_insert=1 cannot apply. Nothing ran."
    )
    with pytest.raises(MigrateError) as error:
        assert_insert_settings_changeable(
            _SettingsClient(fixed_at("wait_for_async_insert", "0")),  # type: ignore[arg-type]
            {"wait_for_async_insert": "false"},
        )
    assert str(error.value) == (
        "Setting wait_for_async_insert is fixed at 0 for this ClickHouse user, and chkit "
        "migrate needs wait_for_async_insert = 1 so that a statement it records as applied "
        "is stored. Nothing ran."
    )


def test_insert_settings_check_names_url_when_a_fixed_setting_prevents_an_override() -> None:
    client = _SettingsClient([{"name": "async_insert", "value": "0", "readonly": 1}])
    with pytest.raises(MigrateError) as error:
        assert_insert_settings_changeable(
            client, None, {"async_insert": "1"}  # type: ignore[arg-type]
        )
    assert error.value.code == "insert_settings_fixed"
    assert str(error.value) == (
        "Setting async_insert is fixed at 0 for this ClickHouse user, so "
        "async_insert=1 from clickhouse.url cannot apply. Nothing ran."
    )
