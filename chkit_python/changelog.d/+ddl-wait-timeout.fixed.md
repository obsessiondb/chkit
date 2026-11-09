**Behaviour change:** a DDL propagation wait that times out stops `migrate` with an error,
as in TS (#464), instead of printing `⚠ DDL propagation wait failed` and recording the
migration as applied. The wait errors use the TS names (`waitForTable: ... not yet
visible`).
