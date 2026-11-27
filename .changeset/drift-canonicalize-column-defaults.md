---
"chkit": patch
---

`drift` and `check` recognize equivalent stored expressions, function aliases, engine quoting, managed `Replicated*`/`Shared*` engines and ClickHouse UNION/CTE/UDF rewrites, and exclude materialized-view backing tables. Parenthesized skip-index expressions no longer trigger drift or needless `generate` changes, and `pull` writes their canonical form.
