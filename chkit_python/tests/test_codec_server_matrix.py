"""Server fixture contract, identical to codec-server-matrix.test.ts."""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from chkit.core.codec import (
    canonicalize_codec,
    codec_fingerprint,
    codec_raw,
    parse_codec,
    render_codec,
)
from chkit.core.model import table
from chkit.core.planner import plan_diff
from chkit.core.sql import column_type_fingerprint
from chkit.core.validate import validate_definitions

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/codec-server-matrix.json").read_text()
)

# Identical ordered patterns and reasons in codec-server-matrix.test.ts.
EXCEPTIONS = [
    ("non-codec", "error", r"Incompatible data types between aggregate function", "SimpleAggregateFunction return type differs from its storage type."),
    ("non-codec", "error", r"similar types", "Variant alternatives require a server setting."),
    ("non-codec", "error", r"Syntax error:|Duplicate values in enum:|Elements of Enum data type", "Invalid Enum syntax or duplicate values are type errors."),
    ("non-codec", "error", r"Map cannot have a key|Names are specified not for all elements|Nullable Tuple type is not allowed|DataTypeLowCardinality is supported only", "Invalid Map key, partially named Tuple, Nullable(Tuple) or LowCardinality of a compound type is a type error."),
    ("unmodelled", "type", r"\b(Variant|AggregateFunction|Nested)\s*\(", "chkit does not model these value streams (Nested has no parent column)."),
    ("integer-bound", "codec", r"^LZ4HC\(-?9007199254740992\)$|^ZSTD\(-9223372036854775808\)$", "Codec arguments beyond the shared JS safe-integer bound stay unparsed."),
    ("aliases", "type", r"\b(Double|BIGINT)\b", "SQL type aliases: ClickHouse stores them under the canonical name, so the type itself already differs."),
]


def matrix_table(type_, spec):
    return table(database="db", name="t", engine="MergeTree()", primaryKey=[], orderBy=[],
                 columns=[{"name": "c", "type": type_, "codec": spec}])


def check_stored(entry, forms, issues, check):
    live = parse_codec(entry["stored"])
    assert live is not None
    pulled = canonicalize_codec(live)
    expected = codec_fingerprint(live, entry["storedType"])
    # Do not let both sides silently erase a significant stored size.
    for atom in live:
        if atom.kind == "DoubleDelta" and atom.size is not None:
            check(f"DoubleDelta({atom.size})" in expected,
                  "stored DoubleDelta size is significant")
        if atom.kind == "FPC" and atom.float_size is not None:
            check(f"FPC({12 if atom.level is None else atom.level},{atom.float_size})" in expected,
                  "stored FPC size is significant")
    check(codec_fingerprint(pulled, entry["storedType"]) == expected,
          "pull canonicalization")
    check(codec_fingerprint(parse_codec(render_codec(pulled)), entry["storedType"]) == expected,
          "pull render round trip")
    for index, spec in enumerate(forms):
        check(not issues[index], f"validation form {index}: {issues[index]}")
        check(codec_fingerprint(canonicalize_codec(spec), entry["type"]) == expected,
              f"drift form {index}")
        source = matrix_table(entry["type"], spec)
        target = matrix_table(entry["storedType"], pulled)
        if not issues[index] and column_type_fingerprint(source.columns[0]) == column_type_fingerprint(target.columns[0]):
            check(not plan_diff([source], [target]).operations, f"planner form {index}")
            check(not plan_diff([target], [source]).operations, f"reverse planner form {index}")


def test_codec_server_matrix():
    failures = []
    rows = []
    counts = {"stored": 0, "rejected": 0, "exceptions": Counter()}
    hits = [0] * len(EXCEPTIONS)
    for entry in FIXTURE["cases"]:
        matches = [i for i, (_, field, pattern, _) in enumerate(EXCEPTIONS)
                   if re.search(pattern, entry.get(field, ""))]
        exception_index = matches[0] if matches else None
        exception = EXCEPTIONS[exception_index] if exception_index is not None else None
        parsed = parse_codec(f"CODEC({entry['codec']})")
        forms = [codec_raw(entry["codec"])]
        if parsed and all(atom.kind != "raw" for atom in parsed):
            forms.append(parsed)
        issues = [[[issue.code, issue.message]
                   for issue in validate_definitions([matrix_table(entry["type"], spec)])
                   if issue.code.startswith("codec_")] for spec in forms]
        rows.append([entry["type"], entry["codec"], entry["server"],
                     exception[0] if exception else "", issues])
        if exception is not None:
            hits[exception_index] += 1
            counts["exceptions"][exception[0]] += 1
        else:
            def check(ok, label, entry=entry):
                if not ok:
                    failures.append(f"{entry['type']} / {entry['codec']}: {label}")

            if entry["server"] == "rejected":
                counts["rejected"] += 1
                for result in issues:
                    check(bool(result), "validation accepted server rejection")
            else:
                check(entry["server"] == "stored", "missing exception for absent parent column")
                if entry["server"] == "stored":
                    counts["stored"] += 1
                    check_stored(entry, forms, issues, check)
    # Same digest in both ports: every raw/typed verdict and exact issue text,
    # including exceptions, in fixture order.
    digest = hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    print("codec-server-matrix", json.dumps(counts), digest)
    assert all(hits)
    assert not failures, "\n".join(failures)
    assert digest == "3bb6c4c90e28c625e4f0955cda2fca58e13b1611446b77b81aea9c8f15e14085"
