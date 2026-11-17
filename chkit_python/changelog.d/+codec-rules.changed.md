Column codecs follow ClickHouse's rules and stored forms, as in TS (#465). **After
upgrading, `generate` plans a codec change for every `Delta` or `Gorilla` column written
without `size`.** chkit-py rendered a bare `Delta` as `Delta(1)` and a bare `Gorilla` as
`Gorilla(1)` and stored `size: 1` in the snapshot; one byte is the wrong width for anything
but 8-bit columns (on 5M rows, `Delta(1), ZSTD(1)` compressed a `UInt64` column 2.42×
against 4.77× for `Delta(8)`, and `Gorilla(1)` made a `Float64` column larger: 0.88×
against 8.52×). They now render bare and ClickHouse fills in the value width, so the next
`generate` plans one `MODIFY COLUMN ... CODEC(...)` per such column, and `drift` reports the
column until that migration runs. It runs no mutation: only parts written after it use the
new codec. A column whose schema sets `size=1` is unchanged.
