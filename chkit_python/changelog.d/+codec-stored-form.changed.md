`generate`, `drift` and `pull` compare codecs in the form ClickHouse stores, so respellings
plan nothing and a live change of the `ZSTD` window drifts. `pull` writes stored codecs as
typed atoms (`FPC(12)` as `{"kind": "FPC", "level": 12}`, `DoubleDelta` with its size when the server retains it).
