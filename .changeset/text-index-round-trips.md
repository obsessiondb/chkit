---
"@chkit/core": minor
"@chkit/clickhouse": patch
"@chkit/plugin-pull": minor
"chkit": minor
---

Support ClickHouse `text` indexes in schemas, migrations, pull, and drift. Text
indexes require a tokenizer and support preprocessing, postprocessing, phrase
search, and dictionary/posting-list options when supported by the server.
Granularity is automatic. Preserve whitespace and escapes inside SQL literals,
compare parameter order and SQL formatting consistently, and reject unsupported
or malformed metadata instead of silently losing settings. Includes Python parity
and live adversarial round-trip tests on ClickHouse 26.3 and 26.8.
