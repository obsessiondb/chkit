"""Immutable migration query intents, shared on the wire with the TS CLI."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from chkit import __version__
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.core.identifier import quote_identifier
from chkit.core.sql_fingerprint import statement_fingerprint
from chkit.core.sql_lexer import SQLToken, identifier_name, is_trivia, tokenize_sql

if TYPE_CHECKING:
    from chkit.cli.commands.migrate_lock import LockTarget, MigrateLock

QUERY_INTENT_PREFIX = "__chkit_migrate_query__/"
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

    def to_payload(self) -> dict[str, str]:
        return {"database": self.database, "name": self.name}


@dataclass(frozen=True, slots=True)
class QueryClassification:
    kind: QueryKind
    target: QueryTarget | None = None


class QueryTracker:
    """Record a verified intent before admitting each physical command attempt."""

    def __init__(
        self, client: Any, target: LockTarget, identity: QueryIdentity, lock: MigrateLock
    ) -> None:
        if not callable(getattr(client, "execute_tracked", None)) or not lock.claim_id:
            raise cancellation_error("This executor does not support tracked commands.")
        self._client = client
        self._target = target
        self._identity = identity
        self._lock = lock

    def command(
        self, context: QueryContext, phase: QueryPhase, sql: str,
        settings: dict[str, Any] | None = None,
    ) -> None:
        self._client.execute_tracked(
            sql, self._lock.assert_held,
            lambda: self._record(context, phase, sql, str(uuid.uuid4()), settings=settings),
            settings,
        )

    def record_async(self, context: QueryContext, query_id: str) -> None:
        self._record(context, "forward", context.forward_sql, query_id, kind="async")

    def _record(
        self, context: QueryContext, phase: QueryPhase, sql: str, query_id: str,
        *, kind: QueryKind | None = None, settings: dict[str, Any] | None = None,
    ) -> str:
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
                "query_id" in settings or "wait_for_async_insert" in settings
                or ("async_insert" in settings and str(settings["async_insert"]) != "0")
            )
        )
        intent = {
            **self._identity.to_payload(), "claim": self._lock.claim_id, "queryId": query_id,
            "migration": context.migration, "statementIndex": context.statement_index,
            "phase": phase, "fingerprint": statement_fingerprint(sql),
            "kind": kind or (
                "unsupported" if not matched or unsafe_settings else classification.kind
            ),
            **({"target": classification.target.to_payload()} if classification.target else {}),
        }
        name = f"{QUERY_INTENT_PREFIX}{self._lock.claim_id}/{query_id}"
        checksum = json.dumps(intent, separators=(",", ":"), ensure_ascii=False)
        table = f"{quote_identifier(self._target.database)}.{self._target.journal_table}"
        self._client.execute(
            f"INSERT INTO {table} "
            "(name, applied_at, checksum, chkit_version, migration_completed, operations) "
            f"SELECT {sql_string(name)}, now64(3), {sql_string(checksum)}, "
            f"{sql_string(__version__)}, false, []"
        )
        rows = self._client.query(
            f"SELECT checksum FROM {table} WHERE name = {sql_string(name)} GROUP BY checksum"
        ).rows
        if len(rows) != 1 or rows[0].get("checksum") != checksum:
            raise cancellation_error("The query intent did not read back; no statement was sent.")
        self._lock.assert_held()
        return query_id


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
    if not _local_insert_source(rest):
        return QueryClassification("unsupported")
    compensation = (
        None if before_retry is None
        else classify_query_intent(before_retry, "compensation", None, database)
    )
    return (
        QueryClassification("insert", target)
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


def _local_insert_source(rest: list[SQLToken]) -> bool:
    functions = {
        "NUMBERS", "NUMBERS_MT", "SLEEP", "SLEEPEACHROW", "TOUINT8", "TOUINT16",
        "TOUINT32", "TOUINT64", "TOINT8", "TOINT16", "TOINT32", "TOINT64",
        "TOSTRING", "SELECT", "VALUES",
    }
    depth = 0
    source_depth: int | None = None
    for index, token in enumerate(rest):
        if token.text == "(":
            depth += 1
        if token.text == ")":
            depth -= 1
        if token.text == "," and source_depth is not None and depth <= source_depth:
            return False
        name = identifier_name(token)
        if name is None:
            continue
        name = name.upper()
        if name in {"WITH", "JOIN", "UNION", "IN", "GLOBAL"}:
            return False
        next_token = rest[index + 1] if index + 1 < len(rest) else None
        if name == "FROM":
            source_depth = depth
            source = identifier_name(next_token) if next_token is not None else None
            if (
                source is None or source.upper() not in {"NUMBERS", "NUMBERS_MT"}
                or index + 2 >= len(rest) or rest[index + 2].text != "("
            ):
                return False
        if next_token is not None and next_token.text == "(" and name not in functions:
            return False
    return True


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
