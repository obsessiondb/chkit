"""Records Tinybird's ttl_only_drop_parts default rule.

Runs inside the tinybird-local container, with Tinybird's own Python (the
server's `chtoolset`), and prints a JSON matrix of
`check_ttl_partition_compatibility` verdicts. The plugin's TypeScript rule is
tested against every recorded case (test/fixtures/ttl-partition-matrix.json):

    docker cp parity/probe-ttl.py tinybird-local:/tmp/probe-ttl.py
    docker exec tinybird-local sh -c 'cd /tmp && /usr/bin/python /tmp/probe-ttl.py' \
      > test/fixtures/ttl-partition-matrix.json
"""

import json

from chtoolset import query

COLUMNS = [
    {"name": "ts", "type": "DateTime"},
    {"name": "d", "type": "Date"},
    {"name": "d32", "type": "Date32"},
    {"name": "t64", "type": "DateTime64(3)"},
    {"name": "tz", "type": "DateTime('UTC')"},
    {"name": "n", "type": "Nullable(DateTime)"},
    {"name": "lc", "type": "LowCardinality(DateTime)"},
    {"name": "x", "type": "UInt32"},
]

PARTITIONS = [
    "toYYYYMM({c})", "toStartOfMonth({c})", "toStartOfWeek({c})", "toMonday({c})", "toStartOfDay({c})",
    "toDate({c})", "toYYYYMMDD({c})", "toStartOfHour({c})", "toStartOfMinute({c})", "toStartOfQuarter({c})",
    "toStartOfYear({c})", "toYYYYMMDDhhmmss({c})", "toYear({c})", "toQuarter({c})", "toStartOfFifteenMinutes({c})",
    "{c}", "(toYYYYMM({c}))", "toYYYYMM(`{c}`)", "toStartOfWeek({c}, 1)", "toYYYYMM({c}, 'UTC')",
    "(toYYYYMM({c}), x)", "toYYYYMM(toDate({c}))", "tuple()", "x",
]

INNERS = [
    "{c}", "`{c}`", "toDate({c})", "toStartOfDay({c})", "toStartOfMonth({c})", "toMonday({c})",
    "toStartOfWeek({c})", "toStartOfWeek({c}, 1)", "toStartOfHour({c})", "toStartOfMinute({c})",
    "toStartOfQuarter({c})", "toStartOfYear({c})", "toDateTime({c})", "toDate({c}, 'UTC')", "toYYYYMM({c})",
]

INTERVALS = [
    "toIntervalSecond(1)", "toIntervalSecond(3600)", "toIntervalMinute(1)", "toIntervalMinute(59)",
    "toIntervalMinute(60)", "toIntervalMinute(1440)", "toIntervalHour(1)", "toIntervalHour(23)",
    "toIntervalHour(24)", "toIntervalHour(36)", "toIntervalHour(168)", "toIntervalHour(720)", "toIntervalHour(744)",
    "toIntervalDay(0)", "toIntervalDay(1)", "toIntervalDay(6)", "toIntervalDay(7)", "toIntervalDay(30)",
    "toIntervalDay(31)", "toIntervalDay(91)", "toIntervalDay(92)", "toIntervalDay(365)", "toIntervalDay(366)",
    "toIntervalWeek(1)", "toIntervalWeek(4)", "toIntervalWeek(5)", "toIntervalWeek(13)", "toIntervalWeek(14)",
    "toIntervalWeek(52)", "toIntervalWeek(53)", "toIntervalMonth(1)", "toIntervalMonth(2)", "toIntervalMonth(3)",
    "toIntervalMonth(11)", "toIntervalMonth(12)", "toIntervalQuarter(1)", "toIntervalQuarter(4)",
    "toIntervalYear(1)", "INTERVAL 1 MONTH", "interval 3 day", "toIntervalDay(-1)", "toIntervalDay(1.5)",
    "toIntervalDay(x)", "INTERVAL -1 DAY", "INTERVAL '1 day'",
]

SHAPES = [
    "{inner} + {interval}", "{inner} - {interval}", "({inner} + {interval})", "{inner} + {interval} DELETE",
    "{interval} + {inner}", "{inner} + {interval} WHERE x > 0", "{inner} + {interval} GROUP BY x",
    "{inner} + {interval} TO VOLUME 'slow'", "{inner} + {interval} RECOMPRESS CODEC(ZSTD)",
    "{inner} + {interval} DELETE WHERE x = 1", "{inner} + {interval} + toIntervalDay(1)",
    "{inner} + {interval}, {inner} + {interval} DELETE", "{inner}",
]


def verdict(partition, ttl):
    result = query.check_ttl_partition_compatibility(
        columns=COLUMNS, ttl=ttl, sorting_key="x", primary_key="x", partition_key=partition
    )
    if not result["checked"]:
        return "unchecked"
    return "compatible" if result["error"] is None else "incompatible"


def cases():
    seen = set()
    for column in ["ts", "d", "d32", "t64", "tz", "n", "lc"]:
        for partition in PARTITIONS:
            for inner in INNERS:
                for interval in INTERVALS:
                    # The full product is large: every partition x interval for the plain
                    # shape, every shape for one interval, and every inner for four.
                    shapes = SHAPES if inner == "{c}" and interval == "toIntervalMonth(1)" else SHAPES[:1]
                    if inner != "{c}" and interval not in (
                        "toIntervalMonth(1)", "toIntervalDay(1)", "toIntervalHour(1)", "toIntervalDay(7)"
                    ):
                        continue
                    if column != "ts" and (inner != "{c}" or interval not in ("toIntervalMonth(1)", "toIntervalDay(1)")):
                        continue
                    for shape in shapes:
                        p = partition.format(c=column)
                        t = shape.format(inner=inner.format(c=column), interval=interval)
                        if (p, t) in seen:
                            continue
                        seen.add((p, t))
                        yield p, t
    # A TTL on another column than the partition key.
    for p, t in [("toYYYYMM(ts)", "d + toIntervalMonth(1)"), ("toDate(d)", "ts + toIntervalDay(1)")]:
        yield p, t


matrix = [{"partition": p, "ttl": t, "verdict": verdict(p, t)} for p, t in cases()]
print("{")
print(f'"columns": {json.dumps(COLUMNS)},')
print('"cases": [')
print(",\n".join(json.dumps([c["partition"], c["ttl"], c["verdict"]]) for c in matrix))
print("]}")
