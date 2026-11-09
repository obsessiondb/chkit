"""Drift compares dictionary definitions, live (#492).

ClickHouse stores a dictionary reformatted and with its SOURCE password hidden,
so an unchanged dictionary must read clean, and a dictionary recreated with
another source, structure, layout, lifetime or settings must drift.
"""

from __future__ import annotations

from pathlib import Path

from chkit.cli.commands.drift_payload import build_drift_payload
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_dictionary, wait_for_table
from chkit.clickhouse.introspect import list_dictionary_details
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import ChxResolvedClickHouseConfig, dictionary, table
from chkit.core.snapshot import create_snapshot
from chkit.core.sql import to_create_sql
from tests.e2e_testkit import create_prefix, poll_until, resolve_live_env

# Dictionaries load lazily, so ClickHouse never connects with these passwords.
_SCHEMA_SECRET = "drift-492-schema-secret"
_LIVE_SECRET = "drift-492-live-secret"


def _connect() -> ClickHouseClient:
    env = resolve_live_env()
    return ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    )


def test_unchanged_dictionaries_read_clean_and_recreated_ones_drift_per_clause(
    tmp_path: Path,
) -> None:
    with _connect() as client:
        database = client.database
        prefix = create_prefix("drift_dicts")
        users, users_dict, rates_dict = f"{prefix}users", f"{prefix}users_dict", f"{prefix}rates_dict"
        null_dict, null_table = f"{prefix}null_dict", f"{prefix}null_table"
        rates_query = f"SELECT id, start, stop, price\\nFROM\\t{users}"
        # Spellings that ClickHouse stores another way: lower-case source keys,
        # ``Decimal(10,2)``, ``hashed(shards 4)``, ``MAX 600 MIN 60``, a password
        # it stores as '[HIDDEN]', ``\n`` and ``\t`` escapes in a string, and a
        # comment that reads like a SETTINGS clause.
        definitions = [
            table(
                database=database,
                name=users,
                engine="MergeTree()",
                order_by=["id"],
                columns=[
                    {"name": "id", "type": "UInt64"},
                    {"name": "name", "type": "String"},
                    {"name": "price", "type": "Decimal(10,2)"},
                    {"name": "start", "type": "Date"},
                    {"name": "stop", "type": "Date"},
                ],
            ),
            dictionary(
                database=database,
                name=users_dict,
                primary_key=["id"],
                attributes=[
                    {"name": "id", "type": "UInt64"},
                    {"name": "name", "type": "String", "default": ""},
                    {"name": "price", "type": "Decimal(10,2)", "default": 0},
                ],
                source=(
                    f"clickhouse(table '{users}' db '{database}' user 'default' "
                    f"password '{_SCHEMA_SECRET}')"
                ),
                layout="hashed(shards 4)",
                lifetime="MAX 600 MIN 60",
                settings={"format_csv_allow_single_quotes": 0},
            ),
            dictionary(
                database=database,
                name=rates_dict,
                primary_key=["id"],
                attributes=[
                    {"name": "id", "type": "UInt64"},
                    {"name": "start", "type": "Date"},
                    {"name": "stop", "type": "Date"},
                    {"name": "price", "type": "Decimal(10,2)", "default": 0},
                ],
                source=f"CLICKHOUSE(QUERY '{rates_query}' DB '{database}')",
                layout="range_hashed()",
                lifetime="0",
                range={"min": "start", "max": "stop"},
                comment="uses SETTINGS(x = 1)",
            ),
        ]
        snapshot = create_snapshot(canonicalize_definitions(definitions))

        def dictionary_drift() -> list[tuple[str, str, str | None, str | None]]:
            payload = build_drift_payload(
                client=client, meta_dir=tmp_path, snapshot=snapshot, database=database
            )
            return [
                (d.code, d.object, d.expected, d.actual)
                for d in payload.object_drift
                # The ENGINE = Dictionary table and its dictionary are not in the schema.
                if prefix in d.object and d.code != "extra_object"
            ]

        try:
            for definition in definitions:
                client.execute(to_create_sql(definition))
            wait_for_dictionary(client, database, users_dict)
            wait_for_dictionary(client, database, rates_dict)
            assert poll_until(dictionary_drift, lambda seen: seen == []) == []

            # A table with ENGINE = Dictionary has the engine name of a dictionary,
            # but it is not one.
            client.execute(
                f"CREATE DICTIONARY {database}.{null_dict} (id UInt64) PRIMARY KEY id "
                "SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0)"
            )
            client.execute(
                f"CREATE TABLE {database}.{null_table} (id UInt64) "
                f"ENGINE = Dictionary('{database}.{null_dict}')"
            )
            wait_for_dictionary(client, database, null_dict)
            wait_for_table(client, database, null_table)
            listed = [d.name for d in list_dictionary_details(client, [database])]
            assert null_dict in listed
            assert null_table not in listed

            # DROP + CREATE rather than CREATE OR REPLACE, which ObsessionDB does not
            # apply on every replica.
            client.execute(f"DROP DICTIONARY {database}.{users_dict} SYNC")
            client.execute(
                f"CREATE DICTIONARY {database}.{users_dict} "
                "(id UInt64, name String DEFAULT 'n/a', price Decimal(10, 2) DEFAULT 0, age UInt8) "
                f"PRIMARY KEY id SOURCE(CLICKHOUSE(TABLE '{users}_v2' DB '{database}' "
                f"USER 'default' PASSWORD '{_LIVE_SECRET}')) "
                "LAYOUT(FLAT()) LIFETIME(300) SETTINGS(format_csv_allow_single_quotes = 1)"
            )
            client.execute(f"DROP DICTIONARY {database}.{rates_dict} SYNC")
            client.execute(
                f"CREATE DICTIONARY {database}.{rates_dict} "
                "(id UInt64, start Date, stop Date, price Decimal(10, 2) DEFAULT 0) "
                f"PRIMARY KEY id SOURCE(CLICKHOUSE(QUERY '{rates_query}' DB '{database}')) "
                "LAYOUT(RANGE_HASHED()) LIFETIME(0) RANGE(MIN stop MAX start) "
                "COMMENT 'uses SETTINGS(x = 1)'"
            )

            users_object, rates_object = f"{database}.{users_dict}", f"{database}.{rates_dict}"
            rates_attributes = "(`id` UInt64, `start` Date, `stop` Date, `price` Decimal(10, 2) DEFAULT 0)"
            expected_drift = [
                (
                    "structure_mismatch",
                    rates_object,
                    f"{rates_attributes} PRIMARY KEY id RANGE(MIN start MAX stop)",
                    f"{rates_attributes} PRIMARY KEY id RANGE(MIN stop MAX start)",
                ),
                (
                    "source_mismatch",
                    users_object,
                    f"CLICKHOUSE(TABLE '{users}' DB '{database}' USER 'default' PASSWORD '[HIDDEN]')",
                    f"CLICKHOUSE(TABLE '{users}_v2' DB '{database}' USER 'default' PASSWORD '[HIDDEN]')",
                ),
                (
                    "structure_mismatch",
                    users_object,
                    "(`id` UInt64, `name` String DEFAULT '', `price` Decimal(10, 2) DEFAULT 0) "
                    "PRIMARY KEY id",
                    "(`id` UInt64, `name` String DEFAULT 'n/a', `price` Decimal(10, 2) DEFAULT 0, "
                    "`age` UInt8) PRIMARY KEY id",
                ),
                ("layout_mismatch", users_object, "HASHED(SHARDS 4)", "FLAT()"),
                ("lifetime_mismatch", users_object, "MIN 60 MAX 600", "MIN 0 MAX 300"),
                (
                    "dictionary_setting_mismatch",
                    users_object,
                    "format_csv_allow_single_quotes = 0",
                    "format_csv_allow_single_quotes = 1",
                ),
            ]
            drift = poll_until(dictionary_drift, lambda seen: len(seen) == len(expected_drift))
            assert drift == expected_drift
            shown = repr(drift)
            assert _SCHEMA_SECRET not in shown
            assert _LIVE_SECRET not in shown
        finally:
            client.execute(f"DROP DICTIONARY IF EXISTS {database}.{users_dict}")
            client.execute(f"DROP DICTIONARY IF EXISTS {database}.{rates_dict}")
            client.execute(f"DROP TABLE IF EXISTS {database}.{null_table}")
            client.execute(f"DROP DICTIONARY IF EXISTS {database}.{null_dict}")
            client.execute(f"DROP TABLE IF EXISTS {database}.{users} SYNC")
