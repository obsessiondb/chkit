---
"@chkit/plugin-ingest": patch
---

Fail fast on checkpoint configuration the journal cannot honor. `defineStream` now rejects an incremental strategy with an empty `id` or a `version` below 1: such a stream used to report `succeeded` with a bumped checkpoint version while every later run silently restarted from scratch, because the journal never accepted its checkpoint envelope. A saved state that the strategy's `parseState`/`parse` refuses now fails the stream as a configuration error on the first attempt instead of being retried under the source retry policy. `chkit ingest run --backfill` rejects a `--from` later than `--to` with exit code 2 before any stream runs, and a `timestampWindow({ from })` callback that returns something other than a `Date` is reported as a configuration error. Document that offset-less `--from`/`--to` timestamps are read in the process's local time zone, and the clock-skew and `maxChunks` cases in which a timestamp window does not advance.
