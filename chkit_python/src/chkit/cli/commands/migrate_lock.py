"""The migrate lock (#716): one ``migrate --apply`` at a time per journal.

1:1 port of ``packages/cli/src/commands/migrate/lock.ts``; TS and chkit-py
write and read the same claim rows, so their runs exclude each other.

ClickHouse has no row locks, so each run writes a claim row of its own into
the journal and reads every claim back:

- A claim is a journal row named ``LOCK_ROW_PREFIX<uuid>``, with
  ``migration_completed = false``, so every release reads past it as it reads
  past an in-progress migration. Its ``applied_at`` is the server time of its
  last heartbeat; a released claim gets ``RELEASED_AT``, which wins over every
  heartbeat in ``ReplacingMergeTree(applied_at)`` and in the argMax read.
- A run holds the lock when, after its claim is acknowledged, it reads no
  other live claim (not released, last heartbeat younger than the lease).
  Otherwise it releases its claim, waits and tries again, and gives up with
  the holder's details. Of two runs that claim at once, at least one reads the
  other's acknowledged claim, so at most one proceeds; both may back off.
- The read must see every acknowledged claim: on several replicas it reads
  every replica (``clusterAllReplicas``), where the replica that took an
  INSERT has it once acknowledged; on one, it reads with
  ``select_sequential_consistency``, after quorum inserts. A run that cannot
  read its own claim back stops, rather than take a lock it cannot check.
- The holder renews its claim every ``heartbeat_ms``, on a thread with its own
  client. A crashed holder's claim expires ``lease_ms`` after its last
  heartbeat. A holder stops before its next request when no renewal was
  acknowledged for ``valid_ms`` (half the lease), or when its claim reads
  released (--break-lock), so it never runs on while another run may take its
  expired claim.
"""

from __future__ import annotations

import json
import os
import random
import socket
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from chkit import __version__
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.clickhouse.replicas import ReplicaFanout

LOCK_ROW_PREFIX = "__chkit_migrate_lock__/"
# The version of a released claim: newer than any heartbeat.
RELEASED_AT = "2299-12-31 23:59:59.000"
_RELEASED_FROM = "toDateTime64('2299-01-01 00:00:00', 3, 'UTC')"


@dataclass(frozen=True, slots=True)
class LockTimings:
    lease_ms: float = 120_000
    valid_ms: float = 60_000
    heartbeat_ms: float = 10_000
    attempts: int = 5
    backoff_min_ms: float = 500
    backoff_max_ms: float = 2_000


LOCK_TIMINGS = LockTimings()


@dataclass(frozen=True, slots=True)
class LockTarget:
    """Where the claims go: the journal, named in its database."""

    database: str
    journal_table: str
    fanout: ReplicaFanout | None


@dataclass(frozen=True, slots=True)
class LockHolder:
    host: str
    pid: int
    chkit_version: str
    started_at: str


@dataclass(frozen=True, slots=True)
class LockClaim:
    name: str
    holder: LockHolder | None
    # The holder JSON as stored, for a claim chkit cannot parse.
    raw_holder: str
    released: bool
    # Milliseconds since the last heartbeat, by the server's clock.
    age_ms: float


@dataclass(slots=True)
class LockDeps:
    now: Callable[[], float] = field(default=lambda: time.monotonic() * 1000)
    sleep: Callable[[float], None] = field(default=lambda ms: time.sleep(ms / 1000))
    random: Callable[[], float] = field(default=random.random)
    new_id: Callable[[], str] = field(default=lambda: str(uuid.uuid4()))
    timings: LockTimings = LOCK_TIMINGS


def migrate_lock_disabled() -> bool:
    """Whether CHKIT_MIGRATE_LOCK turns the lock off."""
    value = (os.environ.get("CHKIT_MIGRATE_LOCK") or "").strip().lower()
    return value in ("off", "0", "false")


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def _quote_name(value: str) -> str:
    return "`" + value.replace("\\", "\\\\").replace("`", "\\`") + "`"


def claim_insert_sql(target: LockTarget, name: str, holder_json: str, *, released: bool) -> str:
    version = f"toDateTime64('{RELEASED_AT}', 3, 'UTC')" if released else "now64(3)"
    return (
        f"INSERT INTO {_quote_name(target.database)}.{target.journal_table} "
        "(name, applied_at, checksum, chkit_version, migration_completed, operations) "
        f"SELECT '{_escape(name)}', {version}, '{_escape(holder_json)}', "
        f"'{_escape(__version__)}', false, []"
    )


def claims_select_sql(target: LockTarget, own: str) -> str:
    """Every claim not released, plus ``own`` whatever its state, newest version per claim."""
    if target.fanout is not None:
        source = (
            f"clusterAllReplicas('{_escape(target.fanout.cluster)}', "
            f"'{_escape(target.database)}', '{target.journal_table}')"
        )
    else:
        source = f"{_quote_name(target.database)}.{target.journal_table}"
    return (
        f"SELECT name, latest.2 AS holder, latest.1 >= {_RELEASED_FROM} AS released, "
        "toString(toUnixTimestamp64Milli(now64(3)) - toUnixTimestamp64Milli(latest.1)) AS age_ms "
        "FROM (SELECT name, argMax(tuple(applied_at, checksum), applied_at) AS latest "
        f"FROM {source} WHERE startsWith(name, '{LOCK_ROW_PREFIX}') GROUP BY name) "
        f"WHERE NOT released OR name = '{_escape(own)}' ORDER BY name"
    )


def _write_settings(target: LockTarget) -> dict[str, Any] | None:
    """On one replica the read cannot fan out, so a claim is acknowledged once a
    majority of replicas has it, which a read with select_sequential_consistency
    then sees (ReplicatedMergeTree). Plain MergeTree ignores both."""
    if target.fanout is not None:
        return None
    return {"insert_quorum": "auto", "insert_quorum_parallel": 0}


def _read_settings(target: LockTarget) -> dict[str, Any] | None:
    return None if target.fanout is not None else {"select_sequential_consistency": "1"}


def _parse_bool(value: Any) -> bool:
    return value is True or value in {1, "1", "true"}


def _parse_holder(raw: str) -> LockHolder | None:
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(value, dict):
        return None
    host, pid = value.get("host"), value.get("pid")
    if not isinstance(host, str) or not isinstance(pid, int) or isinstance(pid, bool):
        return None
    return LockHolder(
        host=host,
        pid=pid,
        chkit_version=str(value.get("chkitVersion", "")),
        started_at=str(value.get("startedAt", "")),
    )


def _read_claims(client: Any, target: LockTarget, own: str) -> list[LockClaim]:
    rows = client.query(claims_select_sql(target, own), _read_settings(target)).rows
    return [
        LockClaim(
            name=str(row["name"]),
            holder=_parse_holder(str(row["holder"])),
            raw_holder=str(row["holder"]),
            released=_parse_bool(row["released"]),
            age_ms=float(row["age_ms"]),
        )
        for row in rows
    ]


def _write_claim(
    client: Any, target: LockTarget, name: str, holder_json: str, *, released: bool
) -> None:
    client.execute(
        claim_insert_sql(target, name, holder_json, released=released), _write_settings(target)
    )


def describe_holder(claim: LockClaim) -> str:
    holder = claim.holder
    if holder is None:
        return f"claim {claim.name} ({claim.raw_holder or 'no holder details'})"
    return (
        f"pid {holder.pid} on host {holder.host} (chkit {holder.chkit_version}), "
        f"started {holder.started_at}"
    )


def _js_round(value: float) -> int:
    # Math.round: halves round up.
    return int(value + 0.5) if value >= 0 else -int(-value + 0.5)


def _locked_error(
    target: LockTarget, others: list[LockClaim], timings: LockTimings
) -> MigrateError:
    where = f"{target.database}.{target.journal_table}"
    if not others:
        return MigrateError(
            "migrate_locked",
            f"Could not take the migrate lock on {where} in {timings.attempts} attempts: "
            "reading the claim back took too long. Run again.",
        )
    lines = []
    for claim in others:
        ago = max(0, _js_round(claim.age_ms / 1000))
        left = max(0, _js_round((timings.lease_ms - claim.age_ms) / 1000))
        lines.append(
            f"  {describe_holder(claim)}; last heartbeat {ago}s ago, "
            f"expires in {left}s unless renewed"
        )
    body = "\n".join(lines)
    return MigrateError(
        "migrate_locked",
        f"Another chkit migrate run holds the migrate lock on {where}:\n{body}\n"
        "Wait for it to finish and run again. A run that stopped without releasing the lock "
        f"(killed, crashed) loses it {_seconds(timings.lease_ms)}s after its last heartbeat. "
        "If you are sure that run is no longer running, re-run with --break-lock.",
    )


def _seconds(ms: float) -> str:
    value = ms / 1000
    return str(int(value)) if value == int(value) else str(value)


def _unverifiable_error(target: LockTarget) -> MigrateError:
    return MigrateError(
        "migrate_lock_unverifiable",
        f"Cannot take the migrate lock on {target.database}.{target.journal_table}: a read right "
        "after this run wrote its claim did not return it, so this target does not give the "
        "read-after-write consistency the lock relies on. Make sure no other migrate runs, "
        "then set CHKIT_MIGRATE_LOCK=off to migrate without the lock.",
    )


def _break_claims(
    client: Any, target: LockTarget, deps: LockDeps, log: Callable[[str], None]
) -> None:
    """Releases every claim that is not released and has not expired, for --break-lock."""
    claims = [
        claim
        for claim in _read_claims(client, target, "")
        if not claim.released and claim.age_ms < deps.timings.lease_ms
    ]
    for claim in claims:
        _write_claim(client, target, claim.name, claim.raw_holder, released=True)
        log(f"Broke the migrate lock held by {describe_holder(claim)}.")


class MigrateLock:
    """A held migrate lock: a heartbeat thread renews the claim until release()."""

    def __init__(
        self,
        client: Any,
        heartbeat_client: Any,
        target: LockTarget,
        *,
        name: str,
        holder_json: str,
        confirmed_at: float,
        deps: LockDeps,
        log: Callable[[str], None],
    ) -> None:
        self._client = client
        self._heartbeat_client = heartbeat_client
        self._target = target
        self._name = name
        self._holder_json = holder_json
        self._confirmed_at = confirmed_at
        self._deps = deps
        self._log = log
        self._lost: str | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="chkit-migrate-lock", daemon=True)
        self._thread.start()

    def _lapsed(self, at: float) -> bool:
        return at - self._confirmed_at > self._deps.timings.valid_ms

    def _lapsed_reason(self, at: float) -> str:
        return f"no heartbeat was acknowledged for {_js_round((at - self._confirmed_at) / 1000)}s"

    def _run(self) -> None:
        while not self._stop.wait(self._deps.timings.heartbeat_ms / 1000):
            if self._lost is not None:
                return
            self._heartbeat()

    def _heartbeat(self) -> None:
        # A renewal counts only when it was acknowledged within the validity
        # of the previous one, so two heartbeats are never further apart on
        # the server than valid_ms, and no reader takes a claim this run still
        # acts on for expired.
        sent_at = self._deps.now()
        if self._lapsed(sent_at):
            if self._lost is None:
                self._lost = self._lapsed_reason(sent_at)
            return
        try:
            _write_claim(
                self._heartbeat_client, self._target, self._name, self._holder_json, released=False
            )
            own = next(
                (
                    claim
                    for claim in _read_claims(self._heartbeat_client, self._target, self._name)
                    if claim.name == self._name
                ),
                None,
            )
        except Exception:
            return
        if self._stop.is_set() or own is None:
            return
        if own.released:
            if self._lost is None:
                self._lost = "another run released it (--break-lock)"
            return
        acked = self._deps.now()
        if self._lapsed(acked):
            if self._lost is None:
                self._lost = self._lapsed_reason(acked)
            return
        self._confirmed_at = sent_at

    def assert_held(self) -> None:
        """Raises when the lock may no longer be held."""
        now = self._deps.now()
        if self._lost is None and self._lapsed(now):
            self._lost = self._lapsed_reason(now)
        if self._lost is None:
            return
        raise MigrateError(
            "migrate_lock_lost",
            f"This run lost the migrate lock on {self._target.database}."
            f"{self._target.journal_table} ({self._lost}), so it stopped before its next "
            "request: another run may have taken the lock. Check the journal with chkit "
            "status, then run migrate again.",
        )

    def release(self) -> None:
        self._stop.set()
        # A heartbeat still in flight would race the release write. A hung one
        # is left behind: the release then goes first, and still wins.
        self._thread.join(timeout=5)
        try:
            _write_claim(self._client, self._target, self._name, self._holder_json, released=True)
        except Exception as error:
            self._log(
                f"⚠ Could not release the migrate lock ({error}); other runs can take it "
                f"{_seconds(self._deps.timings.lease_ms)}s after this run's last heartbeat."
            )


def acquire_migrate_lock(
    client: Any,
    target: LockTarget,
    *,
    break_lock: bool,
    log: Callable[[str], None],
    heartbeat_client: Any = None,
    deps: LockDeps | None = None,
) -> MigrateLock:
    """Takes the migrate lock, or raises ``migrate_locked`` naming the holder.

    ``heartbeat_client`` renews the claim from another thread; a client with
    an HTTP session cannot send it while the run's statement is in flight.
    """
    deps = deps or LockDeps()
    timings = deps.timings
    holder = {
        "host": socket.gethostname(),
        "pid": os.getpid(),
        "chkitVersion": __version__,
        "startedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
    }
    holder_json = json.dumps(holder, separators=(",", ":"), ensure_ascii=False)
    if break_lock:
        _break_claims(client, target, deps, log)

    attempt = 1
    while True:
        name = f"{LOCK_ROW_PREFIX}{deps.new_id()}"
        sent_at = deps.now()
        _write_claim(client, target, name, holder_json, released=False)
        claims = _read_claims(client, target, name)
        own = next((claim for claim in claims if claim.name == name), None)
        others = [
            claim
            for claim in claims
            if claim.name != name and not claim.released and claim.age_ms < timings.lease_ms
        ]
        if (
            own is not None
            and not own.released
            and not others
            and deps.now() - sent_at <= timings.valid_ms
        ):
            return MigrateLock(
                client,
                heartbeat_client if heartbeat_client is not None else client,
                target,
                name=name,
                holder_json=holder_json,
                confirmed_at=sent_at,
                deps=deps,
                log=log,
            )
        _write_claim(client, target, name, holder_json, released=True)
        if own is None:
            raise _unverifiable_error(target)
        if attempt >= timings.attempts:
            raise _locked_error(target, others, timings)
        spread = timings.backoff_max_ms - timings.backoff_min_ms
        deps.sleep(timings.backoff_min_ms + deps.random() * spread)
        attempt += 1


class GuardedClient:
    """Calls ``check`` before every request of ``client`` but ``close``."""

    __slots__ = ("_check", "_client")

    def __init__(self, client: Any, check: Callable[[], None]) -> None:
        self._client = client
        self._check = check

    def __getattr__(self, name: str) -> Any:
        value = getattr(self._client, name)
        if not callable(value) or name == "close":
            return value

        def guarded(*args: Any, **kwargs: Any) -> Any:
            self._check()
            return value(*args, **kwargs)

        return guarded


__all__ = [
    "LOCK_ROW_PREFIX",
    "LOCK_TIMINGS",
    "RELEASED_AT",
    "GuardedClient",
    "LockDeps",
    "LockTarget",
    "LockTimings",
    "MigrateLock",
    "acquire_migrate_lock",
    "claim_insert_sql",
    "claims_select_sql",
    "migrate_lock_disabled",
]
