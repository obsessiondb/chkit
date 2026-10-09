"""Port of ``packages/cli/src/test/runtime/snapshot-document.test.ts`` plus the
``serializeSnapshot`` / ``writeSnapshot`` cases from ``packages/codegen/src/index.test.ts``."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from chkit.cli.migration_store import (
    SnapshotReadError,
    read_snapshot,
    serialize_snapshot,
    write_snapshot,
)
from chkit.cli.snapshot_document import (
    ReadableSnapshotDocument,
    SnapshotDiff,
    UnreadableSnapshotDocument,
    diff_snapshot_definitions,
    parse_snapshot_document,
)
from chkit.core import (
    canonicalize_definitions,
    create_snapshot,
    dictionary,
    materialized_view,
    table,
    view,
)
from chkit.core.model import SchemaDefinition, Snapshot

GENERATED_AT = "2026-01-02T03:04:05.678Z"

USERS = table(
    database="app",
    name="users",
    columns=[{"name": "id", "type": "UInt64"}, {"name": "email", "type": "String"}],
    engine="MergeTree()",
    primary_key=["id"],
    order_by=["id"],
)
EVENTS = table(
    database="app",
    name="events",
    columns=[{"name": "id", "type": "UInt64"}, {"name": "source", "type": "String"}],
    engine="MergeTree()",
    primary_key=["id"],
    order_by=["id"],
)
USERS_VIEW = view(database="app", name="users_view", as_="SELECT id FROM app.users")


def _snapshot(definitions: list[SchemaDefinition], generated_at: str = GENERATED_AT) -> Snapshot:
    return Snapshot.model_validate(
        {
            "version": 1,
            "generatedAt": generated_at,
            "definitions": [
                d.model_dump(by_alias=True) for d in canonicalize_definitions(definitions)
            ],
        }
    )


def _snapshot_text(definitions: list[SchemaDefinition]) -> str:
    return serialize_snapshot(_snapshot(definitions))


def _conflict_on_generated_at(text: str, *, open_: str, separator: str, close: str) -> str:
    """Wrap the ``generatedAt`` line in conflict markers, as two branches that each ran generate do."""
    lines: list[str] = []
    for line in text.split("\n"):
        if '"generatedAt"' in line:
            lines.extend(
                [open_, line, separator, '  "generatedAt": "2026-01-01T00:00:00.000Z",', close]
            )
        else:
            lines.append(line)
    return "\n".join(lines)


def _expect_parsed(raw: str) -> Snapshot:
    parsed = parse_snapshot_document(raw)
    assert isinstance(parsed, ReadableSnapshotDocument), parsed
    return parsed.snapshot


def _unreadable(reason: str) -> UnreadableSnapshotDocument:
    return UnreadableSnapshotDocument(reason=reason)  # type: ignore[arg-type]


# ---------- parse_snapshot_document ----------


def test_reads_a_snapshot_written_by_generate_and_returns_canonical_definitions() -> None:
    snapshot = _expect_parsed(_snapshot_text([USERS_VIEW, USERS]))

    assert snapshot.generated_at == GENERATED_AT
    assert list(snapshot.definitions) == canonicalize_definitions([USERS, USERS_VIEW])
    assert [d.kind for d in snapshot.definitions] == ["table", "view"]


def test_canonicalizes_entries_that_an_older_chkit_stored_differently() -> None:
    raw = json.dumps(
        {
            "version": 1,
            "generatedAt": GENERATED_AT,
            "definitions": [
                {"kind": "view", "database": "app", "name": "v", "as": "SELECT  id\n   FROM app.users"}
            ],
        }
    )

    snapshot = _expect_parsed(raw)

    assert list(snapshot.definitions) == canonicalize_definitions(
        [view(database="app", name="v", as_="SELECT id FROM app.users")]
    )


def test_defaults_missing_fields_like_before() -> None:
    snapshot = _expect_parsed("{}")

    assert snapshot.version == 1
    assert snapshot.generated_at == ""
    assert list(snapshot.definitions) == []


def test_reports_an_empty_file() -> None:
    assert parse_snapshot_document("") == _unreadable("empty")
    assert parse_snapshot_document("  \n") == _unreadable("empty")


def test_detects_git_conflict_markers_around_the_generated_at_line() -> None:
    raw = _conflict_on_generated_at(
        _snapshot_text([USERS]), open_="<<<<<<< HEAD", separator="=======", close=">>>>>>> feature"
    )

    assert parse_snapshot_document(raw) == _unreadable("conflict_markers")


def test_detects_conflict_markers_that_split_a_definition_between_the_two_sides() -> None:
    raw = "\n".join(
        [
            "{",
            '  "version": 1,',
            f'  "generatedAt": "{GENERATED_AT}",',
            '  "definitions": [',
            "    {",
            '      "database": "app",',
            "<<<<<<< HEAD",
            '      "name": "v_m1",',
            '      "as": "SELECT 1",',
            "=======",
            '      "name": "v_m2",',
            '      "as": "SELECT 2",',
            ">>>>>>> 06bdb86 (B)",
            '      "kind": "view"',
            "    }",
            "  ]",
            "}",
            "",
        ]
    )

    assert parse_snapshot_document(raw) == _unreadable("conflict_markers")


def test_detects_diff3_markers_longer_markers_and_crlf_line_endings() -> None:
    diff3 = _conflict_on_generated_at(
        _snapshot_text([USERS]),
        open_="<<<<<<< HEAD",
        separator='||||||| base\n  "generatedAt": "2025-12-31T00:00:00.000Z",\n=======',
        close=">>>>>>> feature",
    )
    long_markers_with_crlf = _conflict_on_generated_at(
        _snapshot_text([USERS]),
        open_="<<<<<<<<<< ours",
        separator="==========",
        close=">>>>>>>>>> theirs",
    ).replace("\n", "\r\n")

    assert parse_snapshot_document(diff3) == _unreadable("conflict_markers")
    assert parse_snapshot_document(long_markers_with_crlf) == _unreadable("conflict_markers")


def test_reports_other_unparseable_text_as_invalid_json() -> None:
    assert parse_snapshot_document('{ "version": 1,') == _unreadable("invalid_json")
    assert parse_snapshot_document('{ "version": 1 } <<<<<<< HEAD') == _unreadable("invalid_json")
    assert parse_snapshot_document("{\n======= x\n}") == _unreadable("invalid_json")


def test_never_reads_marker_like_text_inside_a_valid_snapshot_as_a_conflict() -> None:
    marker_view = view(
        database="app",
        name="markers",
        as_="SELECT '=======' AS a, '<<<<<<< HEAD' AS b, '>>>>>>> feature' AS c",
    )

    snapshot = _expect_parsed(_snapshot_text([marker_view]))

    assert list(snapshot.definitions) == canonicalize_definitions([marker_view])


def test_raises_for_json_that_is_not_a_chkit_snapshot() -> None:
    with pytest.raises(ValueError, match="definitions"):
        parse_snapshot_document('{"definitions":{}}')


# ---------- diff_snapshot_definitions ----------


def test_reports_no_differences_for_identical_definitions() -> None:
    definitions = canonicalize_definitions([USERS, EVENTS, USERS_VIEW])

    assert diff_snapshot_definitions(definitions, definitions) == SnapshotDiff()


def test_lists_added_removed_and_changed_keys_in_canonical_order() -> None:
    other_view = view(database="app", name="events_view", as_="SELECT id FROM app.events")
    users_with_created_at = table(
        database="app",
        name="users",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "email", "type": "String"},
            {"name": "created_at", "type": "DateTime"},
        ],
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
    )
    previous = canonicalize_definitions([USERS, EVENTS, USERS_VIEW])
    next_definitions = canonicalize_definitions([users_with_created_at, USERS_VIEW, other_view])

    assert diff_snapshot_definitions(previous, next_definitions) == SnapshotDiff(
        added=["view:app.events_view"],
        removed=["table:app.events"],
        changed=["table:app.users"],
    )


def test_ignores_object_key_order_and_keys_holding_none() -> None:
    view_a = canonicalize_definitions(
        [view(database="app", name="v", as_="SELECT 1")]
    )
    view_b = canonicalize_definitions(
        [view(name="v", as_="SELECT 1", database="app", comment=None)]
    )
    table_b = canonicalize_definitions(
        [
            table(
                order_by=["id"],
                primary_key=["id"],
                engine="MergeTree()",
                columns=[{"type": "UInt64", "name": "id"}, {"type": "String", "name": "email"}],
                name="users",
                database="app",
            )
        ]
    )

    assert diff_snapshot_definitions(view_a, view_b) == SnapshotDiff()
    assert diff_snapshot_definitions(canonicalize_definitions([USERS]), table_b) == SnapshotDiff()


def test_treats_a_different_column_order_as_a_change() -> None:
    reordered = USERS.model_copy(update={"columns": list(reversed(USERS.columns))})

    assert diff_snapshot_definitions(
        canonicalize_definitions([USERS]), canonicalize_definitions([reordered])
    ) == SnapshotDiff(changed=["table:app.users"])


def test_finds_no_differences_after_a_round_trip_through_the_written_file() -> None:
    definitions: list[SchemaDefinition] = [
        table(
            database="app",
            name="events",
            columns=[
                {
                    "name": "id",
                    "type": "UInt64",
                    "codec": [{"kind": "Delta", "size": 8}, {"kind": "ZSTD", "level": 3}],
                },
                {"name": "ts", "type": "DateTime64(3)", "default": "fn:now64(3)", "comment": " created "},
                {"name": "source", "type": "LowCardinality(String)", "nullable": True},
                {"name": "body", "type": "String"},
            ],
            engine="ReplacingMergeTree(ts)",
            primary_key=["id"],
            order_by=["id", "ts"],
            partition_by="toYYYYMM(ts)",
            ttl="toDateTime(ts) + INTERVAL 30 DAY",
            settings={"index_granularity": 8192, "allow_nullable_key": 1},
            indexes=[
                {"name": "idx_src", "expression": "source", "type": "set", "maxRows": 0, "granularity": 1},
                {"name": "idx_body", "expression": "body", "type": "text", "tokenizer": "splitByNonAlpha"},
            ],
            projections=[{"name": "p_ts", "query": "SELECT id, ts ORDER BY ts"}],
            comment="events table",
        ),
        view(database="app", name="v_events", as_="SELECT id\n  FROM   app.events", comment="v"),
        materialized_view(
            database="app",
            name="mv_refresh",
            to={"database": "app", "name": "events"},
            as_="SELECT id, ts, source, body FROM app.events",
            refresh={
                "every": "1 hours",
                "dependsOn": [{"database": "app", "name": "mv_other"}],
                "settings": {"b": 1, "a": 2},
            },
        ),
        dictionary(
            database="app",
            name="dict_src",
            attributes=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String", "default": ""},
            ],
            primary_key=["id"],
            source="CLICKHOUSE(TABLE 'events' DB 'app')",
            layout="HASHED()",
            lifetime="MIN 0 MAX 300",
        ),
    ]

    reread = _expect_parsed(serialize_snapshot(create_snapshot(definitions)))

    assert len(reread.definitions) == 4
    assert diff_snapshot_definitions(
        list(reread.definitions), canonicalize_definitions(definitions)
    ) == SnapshotDiff()


# ---------- serialize_snapshot / write_snapshot ----------


def test_serialize_snapshot_renders_two_space_json_with_a_trailing_newline() -> None:
    snapshot = _snapshot([USERS])
    payload = snapshot.model_dump(mode="json", by_alias=True, exclude_none=True)

    assert serialize_snapshot(snapshot) == json.dumps(payload, indent=2) + "\n"


def test_write_snapshot_creates_meta_dir_and_writes_canonical_definitions(tmp_path: Path) -> None:
    meta_dir = tmp_path / "nested" / "meta"
    snapshot = create_snapshot([USERS_VIEW, USERS])

    path = write_snapshot(meta_dir, snapshot)

    assert path == meta_dir / "snapshot.json"
    assert [d.kind for d in snapshot.definitions] == ["table", "view"]
    assert path.read_text(encoding="utf-8") == serialize_snapshot(snapshot)


# ---------- read_snapshot ----------


def _write_raw(tmp_path: Path, raw: str) -> Path:
    (tmp_path / "snapshot.json").write_text(raw, encoding="utf-8")
    return tmp_path / "snapshot.json"


def test_read_snapshot_names_conflict_markers_and_points_to_rebuild(tmp_path: Path) -> None:
    file = _write_raw(
        tmp_path,
        _conflict_on_generated_at(
            _snapshot_text([USERS]), open_="<<<<<<< HEAD", separator="=======", close=">>>>>>> f"
        ),
    )

    with pytest.raises(SnapshotReadError) as error:
        read_snapshot(tmp_path)

    message = str(error.value)
    assert message.startswith(f"Snapshot {file} contains unresolved merge conflict markers.")
    assert "run `chkit snapshot rebuild`" in message
    assert "https://chkit.obsessiondb.com/cli/snapshot/" in message


@pytest.mark.parametrize(("raw", "detail"), [('{ "version": 1,', ""), ("", " (the file is empty)")])
def test_read_snapshot_suggests_restoring_or_rebuilding_invalid_json(
    tmp_path: Path, raw: str, detail: str
) -> None:
    file = _write_raw(tmp_path, raw)

    with pytest.raises(SnapshotReadError) as error:
        read_snapshot(tmp_path)

    message = str(error.value)
    assert message.startswith(f"Invalid snapshot JSON at {file}{detail}.")
    assert "Outside a merge or rebase, restore the committed version from git." in message
    assert "chkit snapshot rebuild" in message
    assert "remove the file" not in message


def test_read_snapshot_reads_valid_json_leniently(tmp_path: Path) -> None:
    _write_raw(tmp_path, json.dumps({"definitions": []}))

    snapshot = read_snapshot(tmp_path)

    assert snapshot is not None
    assert snapshot.generated_at == ""
