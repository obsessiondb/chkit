"""Immutable migration query intents, shared on the wire with the TS CLI."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from chkit import __version__
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.core.identifier import quote_identifier
from chkit.core.sql_fingerprint import statement_fingerprint
from chkit.core.sql_lexer import SQLToken, identifier_name, is_trivia, tokenize_sql

if TYPE_CHECKING:
    from chkit.cli.commands.migrate_cancellation import RecoveryObligation
    from chkit.cli.commands.migrate_lock import LockTarget, MigrateLock

QUERY_INTENT_PREFIX = "__chkit_migrate_query__/"
CANCELLABLE_SETTINGS = {
    "max_threads", "max_insert_threads", "max_block_size", "max_insert_block_size",
    "min_insert_block_size_rows", "min_insert_block_size_bytes", "async_insert",
}
QueryPhase = Literal["forward", "compensation"]
QueryKind = Literal["insert", "truncate", "async", "unsupported"]


@dataclass(frozen=True, slots=True)
class QueryIdentity:
    protocol: Literal[1]
    principal: str
    server_uuids: list[str]
    cluster: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "protocol": self.protocol, "principal": self.principal,
            "serverUUIDs": self.server_uuids,
            **({"cluster": self.cluster} if self.cluster is not None else {}),
        }


@dataclass(frozen=True, slots=True)
class QueryContext:
    migration: str
    statement_index: int
    forward_sql: str
    before_retry: str | None


@dataclass(frozen=True, slots=True)
class QueryTarget:
    database: str
    name: str
    uuid: str | None = None
    engine: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "database": self.database, "name": self.name,
            **({"uuid": self.uuid, "engine": self.engine} if self.uuid is not None else {}),
        }


@dataclass(frozen=True, slots=True)
class QueryClassification:
    kind: QueryKind
    target: QueryTarget | None = None
    source: QueryTarget | None = None


@dataclass(frozen=True, slots=True)
class QueryRecovery:
    targets: list[QueryTarget]
    after_compensation: Callable[[QueryTarget], None]
    sources: tuple[QueryTarget, ...] = ()
    obligations: tuple[RecoveryObligation, ...] = ()


class QueryTracker:
    """Record a verified intent before admitting each physical command attempt."""

    def __init__(
        self, client: Any, target: LockTarget, identity: QueryIdentity, lock: MigrateLock,
        recovery: QueryRecovery | None = None,
    ) -> None:
        if not callable(getattr(client, "execute_tracked", None)) or not lock.claim_id:
            raise cancellation_error("This executor does not support tracked commands.")
        self._client = client
        self._target = target
        self._identity = identity
        self._lock = lock
        self._recovery = recovery

    def command(
        self, context: QueryContext, phase: QueryPhase, sql: str,
        settings: dict[str, Any] | None = None,
    ) -> None:
        classification = classify_query_intent(
            sql, phase, context.before_retry, self._target.database,
        )
        expected = next((table for table in self._recovery.targets
                         if classification.target is not None
                         and table.database == classification.target.database
                         and table.name == classification.target.name), None
                        ) if self._recovery else None
        effective_settings = (
            {**(settings or {}), "shared_merge_tree_require_truncate_fence": 1}
            if phase == "compensation" and expected and expected.engine == "SharedMergeTree"
            else settings
        )
        physical_target: QueryTarget | None = None

        def before() -> str:
            nonlocal physical_target
            intent = self._record(context, phase, sql, str(uuid.uuid4()), settings=settings)
            table = intent.get("target")
            if table:
                physical_target = QueryTarget(**table)
            return str(intent["queryId"])

        self._client.execute_tracked(sql, self._lock.assert_held, before, effective_settings)
        self._lock.assert_held()
        if phase == "compensation" and self._recovery:
            if physical_target is None:
                raise cancellation_error("Compensation has no attested target.")
            self._recovery.after_compensation(physical_target)
            self._lock.assert_held()

    def record_async(self, context: QueryContext, query_id: str) -> None:
        self._record(context, "forward", context.forward_sql, query_id, kind="async")

    def _record(
        self, context: QueryContext, phase: QueryPhase, sql: str, query_id: str,
        *, kind: QueryKind | None = None, settings: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self._lock.assert_held()
        classification = classify_query_intent(
            sql, phase, context.before_retry, self._target.database,
        )
        forward = classify_query_intent(
            context.forward_sql, "forward", context.before_retry, self._target.database,
        )
        matched = phase != "compensation" or (
            forward.kind == "insert" and classification.target == forward.target
            and classification.target is not None
        )
        unsafe_settings = (
            settings is not None and (
                any(key not in CANCELLABLE_SETTINGS for key, value in settings.items()
                    if value is not None)
                or ("async_insert" in settings and str(settings["async_insert"]) != "0")
            )
        )
        recorded_target = classification.target
        # Retain the forward source through compensation-only crashes.
        recorded_source = classification.source or (
            forward.source if phase == "compensation" else None
        )
        verified = True
        if kind != "async" and classification.kind != "unsupported" and self._identity.cluster:
            try:
                if recorded_target:
                    recorded_target = attest_query_table(
                        self._client, self._identity, recorded_target,
                    )
                if recorded_source:
                    recorded_source = attest_query_table(
                        self._client, self._identity, recorded_source,
                    )
                    if recorded_target and recorded_source.uuid == recorded_target.uuid:
                        raise cancellation_error("A compensation target cannot also be its source.")
            except Exception:
                # Ordinary SQL still runs; explicit cancellation refuses this claim.
                verified = False
            self._lock.assert_held()
        intent = {
            **self._identity.to_payload(), "claim": self._lock.claim_id, "queryId": query_id,
            "migration": context.migration, "statementIndex": context.statement_index,
            "phase": phase, "fingerprint": statement_fingerprint(sql),
            "forwardFingerprint": statement_fingerprint(context.forward_sql),
            "kind": kind or (
                "unsupported" if not verified or not matched or unsafe_settings
                else classification.kind
            ),
            **({"target": recorded_target.to_payload()} if recorded_target else {}),
            **({"source": recorded_source.to_payload()} if recorded_source else {}),
        }
        if self._recovery and self._recovery.obligations and not any(
            item.migration == context.migration and item.statement_index == context.statement_index
            and item.forward_fingerprint == intent["forwardFingerprint"]
            for item in self._recovery.obligations
        ):
            raise cancellation_error(
                "Explicit recovery requires unchanged recorded forward SQL; no statement was sent."
            )
        if self._recovery and (
            intent["kind"] not in {"insert", "truncate"}
            or recorded_target not in self._recovery.targets
            or (recorded_source is not None and recorded_source not in self._recovery.sources)
        ):
            raise cancellation_error(
                "Explicit cancellation recovery requires supported SQL against the recorded "
                "table identity; no statement was sent."
            )
        name = f"{QUERY_INTENT_PREFIX}{self._lock.claim_id}/{query_id}"
        checksum = json.dumps(intent, separators=(",", ":"), ensure_ascii=False)
        table = f"{quote_identifier(self._target.database)}.{self._target.journal_table}"
        self._client.execute(
            f"INSERT INTO {table} "
            "(name, applied_at, checksum, chkit_version, migration_completed, operations) "
            f"SELECT {sql_string(name)}, now64(3), {sql_string(checksum)}, "
            f"{sql_string(__version__)}, false, [] "
            "SETTINGS async_insert = 0, insert_quorum = 'auto', insert_quorum_parallel = 0"
        )
        source = (f"clusterAllReplicas({sql_string(self._identity.cluster)}, "
                  f"{sql_string(self._target.database)}, {sql_string(self._target.journal_table)})"
                  if self._identity.cluster else table)
        rows = self._client.query(
            f"SELECT checksum FROM {source} WHERE name = {sql_string(name)} GROUP BY checksum "
            "SETTINGS skip_unavailable_shards = 0, select_sequential_consistency = 1"
        ).rows
        if len(rows) != 1 or rows[0].get("checksum") != checksum:
            raise cancellation_error("The query intent did not read back; no statement was sent.")
        self._lock.assert_held()
        return intent


def attest_query_table(client: Any, identity: QueryIdentity, target: QueryTarget) -> QueryTarget:
    cluster = identity.cluster
    if not cluster:
        raise cancellation_error("Table identity cannot be attested.")
    rows = client.query_control(
        "SELECT server_uuid, principal, uuid, engine, dependencies FROM "
        f"clusterAllReplicas({sql_string(cluster)}, view(SELECT "
        "toString(serverUUID()) AS server_uuid, currentUser() AS principal, "
        "toString(uuid) AS uuid, engine, toJSONString(dependencies_table) AS dependencies "
        f"FROM system.tables WHERE database = {sql_string(target.database)} "
        f"AND name = {sql_string(target.name)})) SETTINGS skip_unavailable_shards = 0",
        30_000,
    ).rows
    first = rows[0] if rows else {}
    try:
        if uuid.UUID(str(first.get("uuid", ""))).int == 0:
            raise ValueError("Table has no stable UUID")
    except ValueError as error:
        raise cancellation_error("Table storage identity cannot be attested.") from error
    members = sorted(row.get("server_uuid", "") for row in rows)
    engines = {"MergeTree", "ReplicatedMergeTree", "SharedMergeTree"}
    if members != sorted(identity.server_uuids) or any(
        row.get("principal") != identity.principal
        or row.get("uuid") != first.get("uuid") or row.get("engine") != first.get("engine")
        or row.get("engine") not in engines or row.get("dependencies") != "[]"
        for row in rows
    ):
        raise cancellation_error("Table storage identity or replica coverage is unverified.")
    return QueryTarget(target.database, target.name, str(first["uuid"]), str(first["engine"]))


def classify_query_intent(  # noqa: PLR0911 — mirrors the small TS whitelist's refusal branches
    sql: str, phase: QueryPhase, before_retry: str | None, database: str = ""
) -> QueryClassification:
    """Small executable-SQL whitelist, independent of operation markers."""
    tokens = [token for token in tokenize_sql(sql) if not is_trivia(token)]
    if tokens and tokens[-1].text == ";":
        tokens.pop()
    if any(not token.terminated or token.text == ";" for token in tokens):
        return QueryClassification("unsupported")

    def word(index: int) -> str | None:
        if index >= len(tokens) or tokens[index].kind != "identifier":
            return None
        return tokens[index].text.upper()

    if phase == "compensation":
        if word(0) != "TRUNCATE" or word(1) != "TABLE":
            return QueryClassification("unsupported")
        parsed = _read_target(tokens, 2, database)
        return (
            QueryClassification("truncate", parsed[0])
            if parsed and parsed[1] == len(tokens) else QueryClassification("unsupported")
        )
    if word(0) != "INSERT" or word(1) != "INTO":
        return QueryClassification("unsupported")
    parsed = _read_target(tokens, 2, database)
    if parsed is None:
        return QueryClassification("unsupported")
    target, end = parsed
    rest = tokens[end:]
    if not _has_insert_body(rest):
        return QueryClassification("unsupported")
    unsafe = {"PARALLEL", "INSERT", "ALTER", "CREATE", "DROP", "TRUNCATE", "INTO", "SETTINGS"}
    names = [name.upper() for token in rest if (name := identifier_name(token)) is not None]
    if any(name in unsafe or name.endswith("CLUSTER") or name in {"REMOTE", "REMOTESECURE"}
           for name in names):
        return QueryClassification("unsupported")
    if not any(
        token.kind == "identifier" and token.text.upper() in {"SELECT", "VALUES"} for token in rest
    ):
        return QueryClassification("unsupported")
    allowed, source = _local_insert_source(rest, database or target.database)
    if not allowed:
        return QueryClassification("unsupported")
    if source is not None and source == target:
        return QueryClassification("unsupported")
    compensation = (
        None if before_retry is None
        else classify_query_intent(before_retry, "compensation", None, database)
    )
    return (
        QueryClassification("insert", target, source)
        if compensation and compensation.kind == "truncate" and compensation.target == target
        else QueryClassification("unsupported")
    )


def _has_insert_body(tokens: list[SQLToken]) -> bool:
    index = 0
    if tokens and tokens[0].text == "(":
        index += 1
        expect_name = True
        while index < len(tokens) and tokens[index].text != ")":
            token = tokens[index]
            if (identifier_name(token) is None) if expect_name else (token.text != ","):
                return False
            expect_name = not expect_name
            index += 1
        if expect_name or index >= len(tokens) or tokens[index].text != ")":
            return False
        index += 1
    return (
        index < len(tokens) and tokens[index].kind == "identifier"
        and tokens[index].text.upper() in {"SELECT", "VALUES"}
    )


def _local_insert_source(  # noqa: PLR0911, PLR0912 — explicit fail-closed SQL grammar branches
    rest: list[SQLToken], database: str
) -> tuple[bool, QueryTarget | None]:
    functions = {
        "NUMBERS", "NUMBERS_MT", "SLEEP", "SLEEPEACHROW", "TOUINT8", "TOUINT16",
        "TOUINT32", "TOUINT64", "TOINT8", "TOINT16", "TOINT32", "TOINT64",
        "TOSTRING", "SELECT", "VALUES",
    }
    depth = 0
    source_depth: int | None = None
    source: QueryTarget | None = None
    selects = 0
    for index, token in enumerate(rest):
        if token.text == "(":
            depth += 1
        if token.text == ")":
            depth -= 1
        if token.text == "," and source_depth is not None and depth <= source_depth:
            return False, None
        name = identifier_name(token)
        if name is None:
            continue
        name = name.upper()
        if name == "SELECT":
            selects += 1
            if selects > 1:
                return False, None
        if name in {"WITH", "JOIN", "UNION", "IN", "GLOBAL"}:
            return False, None
        next_token = rest[index + 1] if index + 1 < len(rest) else None
        if name == "FROM":
            if depth != 0 or source_depth is not None:
                return False, None
            source_depth = depth
            source_name = identifier_name(next_token) if next_token is not None else None
            if source_name is None:
                return False, None
            numeric = (source_name.upper() in {"NUMBERS", "NUMBERS_MT"}
                       and index + 2 < len(rest) and rest[index + 2].text == "(")
            if not numeric:
                parsed = _read_target(rest, index + 1, database)
                if parsed is None or (parsed[1] < len(rest) and rest[parsed[1]].text == "("):
                    return False, None
                source = parsed[0]
        if next_token is not None and next_token.text == "(" and name not in functions:
            return False, None
    return True, source


def cancellation_error(message: str) -> MigrateError:
    return MigrateError("migrate_cancellation_failed", message)


def sql_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _read_target(
    tokens: list[SQLToken], start: int, database: str
) -> tuple[QueryTarget, int] | None:
    first = identifier_name(tokens[start]) if start < len(tokens) else None
    if not first:
        return None
    if start + 1 < len(tokens) and tokens[start + 1].text == ".":
        name = identifier_name(tokens[start + 2]) if start + 2 < len(tokens) else None
        return (QueryTarget(first, name), start + 3) if name else None
    return (QueryTarget(database, first), start + 1) if database else None
