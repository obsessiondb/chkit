---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
---

Quote and escape identifiers in generated SQL. Database and object names that are not plain identifiers (e.g. containing `.`, `-` or spaces) are now backtick-quoted, and backticks or backslashes inside any column, index, projection, attribute or object name are escaped. Plain names render exactly as before. `ON CLUSTER` injection understands quoted object references, and validation rejects empty names and names containing control characters (`invalid_identifier`).

Names that need quoting now also round-trip through introspection and drift: key entries that name a declared column are never split on commas, the `CREATE TABLE` parser ignores parens and commas inside quoted names and unescapes projection names, and drift compares key clauses by their unescaped identifiers.
