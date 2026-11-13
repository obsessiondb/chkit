"""The migrate lock (#716): one ``migrate --apply`` at a time per journal.

1:1 port of ``packages/cli/src/commands/migrate/lock.ts``; TS and chkit-py
write and read the same claim rows, so their runs exclude each other.

ClickHouse has no row locks, so each run writes a claim row of its own into
the journal and reads every claim back:

- A claim is a journal row named ``LOCK_ROW_PREFIX<uuid>``, with
  ``migration_completed = false``, so every release reads past it as it reads
  past an in-progress migration. Its ``applied_at`` is its version: the server
  time of the claim, and of each heartbeat after it, but always above the
  version the holder last read back, so it grows whatever the replicas'
  clocks. A released claim gets ``RELEASED_AT``, which wins over every
  heartbeat in ``ReplacingMergeTree(applied_at)`` and in the argMax read.
- A run holds the lock when, after its claim is acknowledged, it reads no
  other claim that is not released. Of two runs that claim at once, at least
  one reads the other's acknowledged claim, so at most one proceeds; both may
  back off, release their claim and try again.
- The read must see every acknowledged claim: on several replicas it reads
  every replica (``clusterAllReplicas``, failing when one does not answer),
  where the replica that took an INSERT has it once acknowledged; on one, it
  reads with ``select_sequential_consistency``, after quorum inserts. A run
  that cannot read its own claim back stops, rather than take a lock it
  cannot check.
- The holder renews its claim every ``heartbeat_ms``, on a thread with its own
  client, numbering each write in the holder JSON. A renewal counts from the
  heartbeat's send time once its row reads back as the claim's newest, within
  ``valid_ms`` of the previous renewal; a heartbeat that does not read back
  stops the run, since it may still reach the server later.
  Every request of the run first checks that the last counted renewal was
  sent less than ``valid_ms`` ago, and that the claim was not released by
  --break-lock.
- A claim whose last heartbeat the server dates more than ``lease_ms`` back
  may belong to a run that stopped. Server clocks of different replicas can
  disagree, so another run takes it for stopped only after it read the same
  version for ``valid_ms + observe_margin_ms`` by its own clock: by then that
  run counts no renewal and makes no request. It then releases it.
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
from chkit.clickhouse.client import clickhouse_error_message
from chkit.clickhouse.replicas import ReplicaFanout

LOCK_ROW_PREFIX = "__chkit_migrate_lock__/"
# Reads of a heartbeat's row, and the wait between two (ms).
_READ_ATTEMPTS = 3
_READ_RETRY_MS = 1_000
# The version of a released claim: newer than any heartbeat.
RELEASED_AT = "2299-12-31 23:59:59.000"
_RELEASED_FROM = "toDateTime64('2299-01-01 00:00:00', 3, 'UTC')"


@dataclass(frozen=True, slots=True)
class LockTimings:
    lease_ms: float = 120_000
    valid_ms: float = 60_000
    heartbeat_ms: float = 10_000
    # Added to valid_ms while watching a claim that looks stopped.
    observe_margin_ms: float = 5_000
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
    # Which write of the holder the row is: 0 for the claim, then one per heartbeat.
    beat: int


@dataclass(frozen=True, slots=True)
class LockClaim:
    name: str
    holder: LockHolder | None
    # The holder JSON as stored, for a claim chkit cannot parse.
    raw_holder: str
    released: bool
    # The claim's newest ``applied_at``, as ``YYYY-MM-DD hh:mm:ss.sss``.
    version: str
    # Milliseconds since the last heartbeat, by the server's clocks.
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


def claim_insert_sql(
    target: LockTarget,
    name: str,
    holder_json: str,
    *,
    released: bool,
    after: str | None = None,
) -> str:
    """A claim row. ``released`` writes the release version; otherwise the
    version is the server time, and above ``after`` (the version last read
    back) when set."""
    if released:
        version = f"toDateTime64('{RELEASED_AT}', 3, 'UTC')"
    elif after is None:
        version = "now64(3)"
    else:
        version = (
            f"greatest(now64(3), toDateTime64('{_escape(after)}', 3, 'UTC') "
            "+ toIntervalMillisecond(1))"
        )
    return (
        f"INSERT INTO {_quote_name(target.database)}.{target.journal_table} "
        "(name, applied_at, checksum, chkit_version, migration_completed, operations) "
        f"SELECT '{_escape(name)}', {version}, '{_escape(holder_json)}', "
        f"'{_escape(__version__)}', false, []"
    )


def claims_select_sql(target: LockTarget, own: str) -> str:
    """Every claim not released, plus ``own`` whatever its state: the newest row
    per claim, and of rows with one version the one of the latest heartbeat, so
    every read of the same rows picks the same one.

    A read that misses a replica could miss the claim on it, so a fanned-out
    read fails instead of skipping an unavailable replica."""
    settings = " SETTINGS skip_unavailable_shards = 0" if target.fanout is not None else ""
    if target.fanout is not None:
        source = (
            f"clusterAllReplicas('{_escape(target.fanout.cluster)}', "
            f"'{_escape(target.database)}', '{target.journal_table}')"
        )
    else:
        source = f"{_quote_name(target.database)}.{target.journal_table}"
    return (
        f"SELECT name, latest.2 AS holder, latest.1 >= {_RELEASED_FROM} AS released, "
        "toString(latest.1) AS version, "
        "toString(toUnixTimestamp64Milli(now64(3)) - toUnixTimestamp64Milli(latest.1)) AS age_ms "
        "FROM (SELECT name, argMax(tuple(applied_at, checksum), "
        "tuple(applied_at, JSONExtractInt(checksum, 'beat'))) AS latest "
        f"FROM {source} WHERE startsWith(name, '{LOCK_ROW_PREFIX}') GROUP BY name) "
        f"WHERE NOT released OR name = '{_escape(own)}' ORDER BY name{settings}"
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
        beat=_beat(value.get("beat")),
    )


def _beat(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else -1


def _read_claims(client: Any, target: LockTarget, own: str) -> list[LockClaim]:
    rows = client.query(claims_select_sql(target, own), _read_settings(target)).rows
    return [
        LockClaim(
            name=str(row["name"]),
            holder=_parse_holder(str(row["holder"])),
            raw_holder=str(row["holder"]),
            released=_parse_bool(row["released"]),
            version=str(row["version"]),
            age_ms=float(row["age_ms"]),
        )
        for row in rows
    ]


def _write_claim(
    client: Any,
    target: LockTarget,
    name: str,
    holder_json: str,
    *,
    released: bool,
    after: str | None = None,
) -> None:
    client.execute(
        claim_insert_sql(target, name, holder_json, released=released, after=after),
        _write_settings(target),
    )


def _claim_id(claim: LockClaim) -> str:
    """The id ``--break-lock`` takes: the claim name without its prefix."""
    return claim.name[len(LOCK_ROW_PREFIX) :]


def describe_holder(claim: LockClaim) -> str:
    holder = claim.holder
    if holder is None:
        who = claim.raw_holder or "no holder details"
    else:
        who = (
            f"pid {holder.pid} on host {holder.host} (chkit {holder.chkit_version}), "
            f"started {holder.started_at}"
        )
    return f"claim {_claim_id(claim)}: {who}"


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
    lines = [
        f"  {describe_holder(claim)}; last heartbeat {_s(claim.age_ms)}s ago, "
        f"free in {_s(timings.lease_ms - claim.age_ms)}s unless renewed"
        for claim in others
    ]
    body = "\n".join(lines)
    return MigrateError(
        "migrate_locked",
        f"Another chkit migrate run holds the migrate lock on {where}:\n{body}\n"
        "Wait for it to finish and run again. A run that stopped without releasing the lock "
        f"(killed, crashed) loses it {_seconds(timings.lease_ms)}s after its last heartbeat. "
        "If you are sure that run is no longer running, re-run with "
        f"--break-lock {_claim_id(others[0])}.",
    )


def _s(ms: float) -> int:
    """Whole seconds, at least 0 (TS ``seconds``)."""
    return max(0, _js_round(ms / 1000))


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


def _break_claim(
    client: Any, target: LockTarget, claim_id: str, log: Callable[[str], None]
) -> None:
    """--break-lock <claim>: releases that claim, which the user checked belongs
    to a run that is no longer running. Any other claim still holds the lock."""
    claim = next(
        (
            item
            for item in _read_claims(client, target, "")
            if not item.released and claim_id in (_claim_id(item), item.name)
        ),
        None,
    )
    if claim is None:
        log(
            f"--break-lock: claim {claim_id} does not hold the migrate lock; "
            "taking the lock as usual."
        )
        return
    _write_claim(client, target, claim.name, claim.raw_holder, released=True)
    log(f"Broke the migrate lock of {describe_holder(claim)}.")


def _release_stopped_claims(
    client: Any,
    target: LockTarget,
    stale: list[LockClaim],
    deps: LockDeps,
    log: Callable[[str], None],
) -> list[LockClaim]:
    """Claims whose last heartbeat the server dates past the lease: reads them
    again after ``valid_ms + observe_margin_ms`` and releases each whose version
    did not change. A run with such a claim counts no renewal any more, so it
    makes no request. Returns the claims whose version changed: their run is
    alive, with a server clock behind."""
    timings = deps.timings
    holders = "; ".join(describe_holder(claim) for claim in stale)
    log(
        f"The migrate lock is held by {holders}, with no heartbeat for "
        f"{_s(min(claim.age_ms for claim in stale))}s; checking for "
        f"{_s(timings.valid_ms + timings.observe_margin_ms)}s that it stopped."
    )
    deps.sleep(timings.valid_ms + timings.observe_margin_ms)
    current = {claim.name: claim for claim in _read_claims(client, target, "")}
    alive: list[LockClaim] = []
    for claim in stale:
        now = current.get(claim.name)
        if now is None or now.released:
            continue
        if now.version != claim.version or now.raw_holder != claim.raw_holder:
            alive.append(now)
            continue
        _write_claim(client, target, claim.name, claim.raw_holder, released=True)
        log(
            f"Released the migrate lock of {describe_holder(claim)}, "
            "which stopped without releasing it."
        )
    return alive


class MigrateLock:
    """A held migrate lock: a heartbeat thread renews the claim until release()."""

    def __init__(
        self,
        client: Any,
        heartbeat_client: Any,
        target: LockTarget,
        *,
        name: str,
        holder: dict[str, Any],
        confirmed_at: float,
        version: str,
        deps: LockDeps,
        log: Callable[[str], None],
    ) -> None:
        self._client = client
        self._heartbeat_client = heartbeat_client
        self._target = target
        self._name = name
        self._holder = holder
        self._confirmed_at = confirmed_at
        self._version = version
        self._beat = 0
        self._deps = deps
        self._log = log
        self._lost: str | None = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="chkit-migrate-lock", daemon=True)
        self._thread.start()

    def _holder_json(self, beat: int) -> str:
        return json.dumps({**self._holder, "beat": beat}, separators=(",", ":"), ensure_ascii=False)

    def _lapsed(self, at: float) -> bool:
        return at - self._confirmed_at > self._deps.timings.valid_ms

    def _lapsed_reason(self, at: float) -> str:
        return f"no heartbeat was acknowledged for {_s(at - self._confirmed_at)}s"

    def _run(self) -> None:
        while not self._stop.wait(self._deps.timings.heartbeat_ms / 1000):
            if self._lost is not None:
                return
            self._heartbeat()

    def _read_own(self) -> LockClaim | None:
        """The claim as read back, retrying a failed read a few times."""
        attempt = 1
        while True:
            try:
                return next(
                    (
                        claim
                        for claim in _read_claims(self._heartbeat_client, self._target, self._name)
                        if claim.name == self._name
                    ),
                    None,
                )
            except Exception:
                if attempt >= _READ_ATTEMPTS:
                    raise
                attempt += 1
                self._deps.sleep(_READ_RETRY_MS)

    def _lose(self, reason: str) -> None:
        if self._lost is None:
            self._lost = reason

    def _heartbeat(self) -> None:
        # Each heartbeat must read back as the claim's newest row before the
        # next one is sent, so the heartbeats' versions grow one after the
        # other, and a merge, which keeps the newest version, keeps the newest
        # heartbeat. A heartbeat whose row does not read back may still reach
        # the server later, with a version a later heartbeat could tie: the run
        # stops instead. A renewal counts from the heartbeat's send time, when
        # it was acknowledged within the validity of the previous one. Another
        # run that reads the same row for longer than valid_ms knows this run
        # counts no renewal.
        sent_at = self._deps.now()
        if self._lapsed(sent_at):
            self._lose(self._lapsed_reason(sent_at))
            return
        self._beat += 1
        write_error: Exception | None = None
        try:
            _write_claim(
                self._heartbeat_client,
                self._target,
                self._name,
                self._holder_json(self._beat),
                released=False,
                after=self._version,
            )
        except Exception as error:
            write_error = error
        try:
            own = self._read_own()
        except Exception as error:
            self._lose(f"cannot read its claim back ({clickhouse_error_message(error)})")
            return
        if self._stop.is_set():
            return
        if own is not None and own.released:
            self._lose("another run released it (--break-lock)")
            return
        if own is None or own.holder is None or own.holder.beat != self._beat:
            self._lose(
                "its heartbeat did not read back"
                if write_error is None
                else f"a heartbeat failed ({clickhouse_error_message(write_error)}) "
                "and may still reach the server"
            )
            return
        acked = self._deps.now()
        if self._lapsed(acked):
            self._lose(self._lapsed_reason(acked))
            return
        self._version = own.version
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
            _write_claim(
                self._client,
                self._target,
                self._name,
                self._holder_json(self._beat),
                released=True,
            )
        except Exception as error:
            self._log(
                f"⚠ Could not release the migrate lock ({error}); other runs can take it "
                f"{_seconds(self._deps.timings.lease_ms)}s after this run's last heartbeat."
            )


def acquire_migrate_lock(
    client: Any,
    target: LockTarget,
    *,
    break_lock: str | None,
    log: Callable[[str], None],
    heartbeat_client: Any = None,
    deps: LockDeps | None = None,
) -> MigrateLock:
    """Takes the migrate lock, or raises ``migrate_locked`` naming the holder.

    ``break_lock`` is the claim id --break-lock names. ``heartbeat_client``
    renews the claim from another thread; a client with an HTTP session cannot
    send it while the run's statement is in flight.
    """
    deps = deps or LockDeps()
    timings = deps.timings
    holder = {
        "host": socket.gethostname(),
        "pid": os.getpid(),
        "chkitVersion": __version__,
        "startedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "beat": 0,
    }
    holder_json = json.dumps(holder, separators=(",", ":"), ensure_ascii=False)
    if break_lock is not None:
        _break_claim(client, target, break_lock, log)

    attempt = 1
    while True:
        name = f"{LOCK_ROW_PREFIX}{deps.new_id()}"
        sent_at = deps.now()
        _write_claim(client, target, name, holder_json, released=False)
        claims = _read_claims(client, target, name)
        own = next((claim for claim in claims if claim.name == name), None)
        others = [claim for claim in claims if claim.name != name and not claim.released]
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
                holder=holder,
                confirmed_at=sent_at,
                version=own.version,
                deps=deps,
                log=log,
            )
        _write_claim(client, target, name, holder_json, released=True)
        if own is None:
            raise _unverifiable_error(target)
        live = [claim for claim in others if claim.age_ms < timings.lease_ms]
        if not live and others:
            alive = _release_stopped_claims(client, target, others, deps, log)
            if alive:
                raise _locked_error(target, alive, timings)
            continue
        if attempt >= timings.attempts:
            raise _locked_error(target, live, timings)
        attempt += 1
        spread = timings.backoff_max_ms - timings.backoff_min_ms
        deps.sleep(timings.backoff_min_ms + deps.random() * spread)


class GuardedClient:
    """Calls ``check`` before every request of ``client`` but ``close``."""

    __slots__ = ("_check", "_client")

    def __init__(self, client: Any, check: Callable[[], None]) -> None:
        self._client = client
        self._check = check

    def __getattr__(self, name: str) -> Any:
        if name == "execute":
            execute_guarded = getattr(self._client, "execute_guarded", None)
            if execute_guarded is not None:
                def guarded_execute(statement: str, settings: dict[str, Any] | None = None) -> None:
                    execute_guarded(statement, self._check, settings)

                return guarded_execute
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
