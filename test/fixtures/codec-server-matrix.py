"""Record what ClickHouse does with each (column type, codec) case.

Usage: python3 test/fixtures/codec-server-matrix.py <cases.json> test/fixtures/codec-server-matrix.json
The cases file is a JSON list of {"type", "codec"}; regenerate when adding cases.
Env: CLICKHOUSE_URL (default http://localhost:8123), CLICKHOUSE_USER, CLICKHOUSE_PASSWORD.

Each case is created in its own table in a throwaway database, which is
dropped at the end. The output keeps the input order and records, per case,
either the stored codec and type (system.columns) or the server's error code.
"""

from __future__ import annotations

import base64
import json
import os
import random
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

SETTINGS = {
    "allow_experimental_codecs": "1",
    "allow_suspicious_low_cardinality_types": "1",
    "allow_experimental_variant_type": "1",
    "allow_experimental_dynamic_type": "1",
    "enable_json_type": "1",
}


def query(sql: str) -> tuple[bool, str]:
    url = os.environ.get("CLICKHOUSE_URL", "http://localhost:8123").rstrip("/")
    request = urllib.request.Request(
        f"{url}/?{urllib.parse.urlencode(SETTINGS)}", data=sql.encode(), method="POST"
    )
    auth = f"{os.environ.get('CLICKHOUSE_USER', 'default')}:{os.environ.get('CLICKHOUSE_PASSWORD', '')}"
    request.add_header("Authorization", "Basic " + base64.b64encode(auth.encode()).decode())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return True, response.read().decode()
    except urllib.error.HTTPError as error:
        return False, error.read().decode()


def main() -> None:
    path = sys.argv[1]
    cases = [{"type": c["type"], "codec": c["codec"]} for c in json.load(open(path))["cases"]]
    database = f"chkit_codec_matrix_{random.randrange(16**8):08x}"
    ok, out = query(f"CREATE DATABASE {database}")
    if not ok:
        sys.exit(out)
    version = query("SELECT version()")[1].strip()
    results = []
    try:
        for index, case in enumerate(cases):
            table = f"{database}.t{index}"
            ok, out = query(
                f"CREATE TABLE {table} (c {case['type']} CODEC({case['codec']})) "
                "ENGINE = MergeTree ORDER BY tuple()"
            )
            if ok:
                _, row = query(
                    "SELECT compression_codec, type FROM system.columns "
                    f"WHERE database = '{database}' AND table = 't{index}' AND name = 'c' "
                    "FORMAT JSONEachRow"
                )
                if not row.strip():
                    # Nested and similar types create subcolumns, not `c`.
                    results.append({**case, "server": "stored-without-column"})
                    continue
                stored = json.loads(row)
                results.append({**case, "server": "stored", "stored": stored["compression_codec"], "storedType": stored["type"]})
            else:
                code = re.search(r"Code: (\d+)", out)
                message = re.sub(r"\s*\(version [^)]*\)\s*$", "", out.strip().splitlines()[0])
                results.append({**case, "server": "rejected", "errorCode": int(code.group(1)) if code else None, "error": message[:160]})
    finally:
        query(f"DROP DATABASE {database} SYNC")
    with open(path, "w") as out_file:
        out_file.write(f'{{"clickhouse": {json.dumps(version)}, "settings": {json.dumps(SETTINGS)}, "cases": [\n')
        out_file.write(",\n".join(json.dumps(r, ensure_ascii=False) for r in results))
        out_file.write("\n]}\n")
    print(f"{len(results)} cases, {sum(r['server'] == 'stored' for r in results)} stored, ClickHouse {version}")


if __name__ == "__main__":
    main()
