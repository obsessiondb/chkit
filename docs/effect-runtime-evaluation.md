# Internal Effect runtime evaluation

Baseline: `031d99539a515b5d9621603c4eb6039283a0fc37`. Candidate: `refactor/effect-runtime-migration-kit3`. Runtime dependency: **Effect 4.0.6**, imported through submodules.

## Recommendation

The implementation covers the internal TypeScript execution runtime, but it is not a code simplification. Production code grows by **2,070 lines** and ordinary extension compatibility requires a substantial private ownership bridge. The final adoption recommendation also depends on the controlled measurements below. This is an evaluation branch, not authorization to merge or deploy.

## Scope and architecture

Effect now composes CLI lifecycle and command dispatch, nested plugin calls, migration/journal/registry orchestration, ClickHouse execution and DDL polling, ingestion execution/retries/loaders/recovery, SQL backfill planning/execution/reconciliation, ObsessionDB authentication/jobs/remote execution, pull, codegen and scaffolding. The implementation uses owned scopes/fibers, suspending queues, semaphores, schedules, clocks and explicit interruption; it does not merely wrap the old asynchronous coordinator in one Effect.

Pure schema, diff, planning policy, transforms, SQL construction and actual Zod schemas remain ordinary TypeScript. Core, Python, examples and provider registry sources are unchanged. Primitive filesystem, module-loader, process and transport adapters remain ordinary functions; an already-started foreign operation can continue after its observer stops. The [module inventory](effect-runtime-coverage.csv) classifies 228 production modules: 87 migrated or removed, 111 intentionally pure and 30 boundary adapters. No runtime subsystem is deferred or blocked.

Public entry points still return ordinary values/promises and accept functions, `AsyncIterable`, `AbortSignal` and injected services. Nine private package helpers share a process-local `AsyncLocalStorage` owner and attach nested work to its actual scope. A returned executor owns initialization through disposal; a loader owns initialization through write/finalize/abort. Creating a new root at every Promise boundary was incorrect: it allowed abandoned pull/SDK work to resume later. Closing each callback's scope at callback return was also incorrect: it cancelled initialization of resources returned by that callback.

This bridge deliberately avoids adding a public runtime package or a customer-facing task algebra. It costs **616 lines across nine modules**, includes duplicated boundary code, and couples tooling to the pinned Effect scope lifecycle. Most foreign error channels remain `unknown`; this migration does not demonstrate exhaustive typed domain errors. Its strongest benefit is composing resource ownership and concurrency.

## Code and dependency comparison

Counts are physical lines, including comments and blanks, using identical baseline/candidate filters. Production includes `packages/*/src/**/*.ts` but excludes tests, e2e helpers and the test-only replica visibility helper. Lockfiles, generated output, tests and documentation are not counted as production.

| Package | Before | After | Net |
| --- | ---: | ---: | ---: |
| CLI | 10,561 | 11,476 | +915 |
| ClickHouse | 2,477 | 2,554 | +77 |
| Codegen | 251 | 316 | +65 |
| Core | 5,997 | 5,997 | 0 |
| Scaffolder | 389 | 447 | +58 |
| Backfill | 5,201 | 5,368 | +167 |
| Codegen plugin | 1,326 | 1,392 | +66 |
| Ingestion | 2,960 | 3,016 | +56 |
| ObsessionDB | 3,276 | 3,874 | +598 |
| Pull | 1,194 | 1,262 | +68 |
| **Total** | **33,632** | **35,702** | **+2,070 (+6.2%)** |

Production diff: 9,932 lines added and 7,862 removed across 92 files. Tests separately add 3,644 and remove four lines: net +3,640 across 28 files, without weakening existing assertions. Removed lines are three imports and one stale fixture configuration corrected for strict compilation. Ten package/root manifests add 14 lines and remove eight; the lockfile adds 15 and removes 11. Documentation consists of two updated plugin references, a changeset, this evaluation and the inventory; it is excluded from the runtime comparison.

The bespoke 56-line ingestion queue is deleted. Direct `p-limit`, `p-retry` and `p-map` dependencies are removed, including root `p-map`; no production Promise-race/Promise-all scheduler remains. Native promises remain at process/event/foreign adapters and the nine ownership bridges. Effect is added to nine execution packages, not core. `is-network-error` remains a direct dependency where the old retry behavior requires its classifier, rather than reimplementing that classifier. Domain checkpoint/receipt/replay state and exact retry-budget bookkeeping remain explicit code: Effect does not replace those policies.

Ingestion itself grows only 56 lines, but much surrounding CLI, authentication and file orchestration is an `await` to `yield*` conversion with adapters. Dependency consolidation does not translate into a smaller overall implementation.

## Compatibility and behavior

The packed harness builds ten tarballs and installs them outside the workspace, without source conditions or repository symlinks. It checks all declared non-executable public entry points, ordinary plugins/hooks/custom readers/loaders/journals/destinations/executors/introspectors/backfill clients, and strict TypeScript consumers with library checking enabled. Real Zod composition, transforms, defaults, inference and `ZodError` identity are exercised.

Generated rows/Zod schemas/insert helpers/runtime migrations/SQL/snapshots/pulled schemas are compared. A separate application installs only packed core and Zod. Cold Node ESM load tracing and the esbuild input graph before tree shaking check that neither Effect nor CLI execution is reachable; the resulting application and bundle execute. This distinguishes three claims: tooling installs and executes Effect; extension authors need not know it; generated application runtime/declaration graphs do not contain it.

Export names alone are insufficient. A draft explicit ingestion plugin interface changed an array of command variants into an object with a union-valued field and broke assignability. The candidate restores the inferred factory return and `ReturnType` alias. A separate bilateral declaration check copies distinct old/new modules to prevent TypeScript from deduplicating packages with the same version; plugin, retry option and retry callback-context assignments must pass both directions. Retry contracts now use equivalent neutral structural types instead of importing `p-retry`. Other public declaration differences are annotations, type-import paths, documentation or ordering; private runtime declarations contain Effect but are not reachable from supported public entry points. Unsupported deep imports are not guaranteed compatible.

The seven packed differential scenarios execute 11 ingestion invocations per package set: success, lost sink acknowledgement/replay, recovered journal acknowledgement, exhausted ambiguous journal acknowledgement both with and without persisted facts, independent failure/restart, and a completed empty frontier followed by source failure. Normalization preserves identity reuse, per-namespace fact order, receipt/checkpoint/outcome values and physical destination effects, while excluding arbitrary inter-stream interleaving. An earlier candidate produced 32 real differences in the empty-frontier case; the harness does not suppress mismatches.

Effect's default queue dispatcher delayed consumer handoff relative to the former Promise queue. `Queue.flush` after each offer restores the supported immediate handoff. A draft empty-marker acknowledgement barrier was removed because it imposed a stronger source-pulling policy than baseline. Custom loader and journal acknowledgement still gate checkpoint publication, not all source prefetch; six added frontier cases also pass against the frozen baseline.

Intentional lifecycle/validation changes are explicit:

- Programmatic ingestion capacities reject invalid, non-finite or unsafe integer values before work starts. Duration must be positive and finite.
- Nested unawaited managed work is abandoned when its owner ends. Callers must await work that must finish. An ordinary callback's own unmanaged JavaScript can still continue.
- Natural executor cleanup waits and retains failure precedence/identity. Abandoned cleanup starts once and waits at most five seconds; cleanup already underway can be interrupted earlier. Borrowed SDK executors are not closed.
- Cancellation stops local observation, not server SQL or arbitrary remote writes. A generator's pending `next()` can delay `finally`, and an already-issued journal append can finish externally. No new managed checkpoint is started from an abandoned result.

## Controlled runtime measurements

Final alternating measurements are pending. The retained initial baseline-only numbers are not used to claim a performance change.

The comparison uses the same quiet machine, Node 24.22.1 and identical ordinary packed-consumer fixtures, with one warmup and seven measured fresh processes per version in alternating order. CLI `--help` includes process startup; ingestion excludes imports and processes 1,000,000 rows of 64-byte payload through one stream and a non-retaining in-memory sink/journal. RSS is the child process high-water mark. This measures orchestration overhead, not real provider/ClickHouse throughput; the filesystem cache is warm/uncontrolled.

Blocked-sink tests measure actual pull-ahead at capacities 1, 2 and 4, three times per version. Queue capacity is not an RSS bound: active load, a pending producer batch, the reader page and customer buffers also retain data.

## Verification and reproduction

The baseline and current candidate have passed `bun run verify` (52/52 tasks), including the canonical classifier and final fixture corrections. Strict compilation of all added/changed tests also passes. Local ClickHouse 26.3, Redpanda/Kafka and the Python suite are included; no existing test is skipped or weakened for this migration. The optional live ObsessionDB target, authenticated workbench API and multi-node cluster suites are not verified.

The independent review includes an 81-pair cross-package ownership matrix, real nested pull/SDK abandonment, returned-resource readiness, registry rollback, backfill sibling failure/late publication, async submission draining and held cleanup beyond five seconds. The ten final packed API/isolation checks and bilateral declaration assignments pass, but the final Node differential has **six unresolved differences** in the empty-frontier failure scenario: an acknowledged fact persists, while managed counters remain zero, terminal publication is lost and interruption replaces the source error. Source-failure interruption is cancelling the consumer's already-issued journal transaction; the correction and its bounded-abandonment checks are in progress. **This snapshot is not behavior-compatible or ready to merge.**

The reusable packed harness is retained in the working evidence directory; the completion handoff will include it and the final measurement dataset once these gates finish. Build each revision normally, then run `capture.mjs`, `prepare.mjs`, `validate.mjs`, `compare.mjs`, `type-parity.mjs`, `differential.mjs` and finally `benchmark.mjs` with no builds/tests running. Its README records exact commands and limits. Frozen baseline traces/checksums and superseded-candidate failures remain separate from final results; this is representative compatibility evidence, not a proof for every possible extension program.
