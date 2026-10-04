# Stable registry syncs

Apply this contract when authoring or improving registry providers. Select mechanisms from official provider documentation and observed response shapes; do not invent change filters or durable cursors. Preserve explicit user constraints. A provider limitation calls for safe replay and an honest coverage statement.

## Establish the source contract

For each resource, record the account/query scope, stable record identity, bootstrap coverage, filter timestamp meaning, ordering, boundary inclusivity, pagination guarantees, cursor lifetime, and retention. Check whether edits, deletions, and child-only changes update the selected timestamp. Determine whether pages are snapshots, live mutable lists, or a change feed. Verify filter/token incompatibilities and provider caps on child collections.

Choose the strongest appropriate mechanism, independently for each resource:

| Provider contract | Selection and durable progress |
| --- | --- |
| Change feed or sync token | Bootstrap completely, retain the input token throughout pagination, and promote a terminal replacement token only after all corresponding writes |
| Reliable modification filter | Fixed upper cutoff and overlapping lower bound; checkpoint a fully consumed window or independently complete bounded interval |
| Creation-time filter | Use for proven immutable events or parent discovery; distinguish discovery progress from freshness, and retain delayed-child work/reconcile later edits separately |
| Full mutable listing | Record scan completion; for expensive reads, freeze parent selection and checkpoint completed parents, replaying unfinished mutable collections from their beginning |

A small catalog can remain a simple full read if its complete cost is acceptable. For a registry resource, explain that choice. A creation timestamp is not a modification cursor; a pagination cursor is not automatically a change token. Runtime `cursorState()` can implement a full scan, so the helper alone does not determine the manifest's strategy label.

In a chkit checkout, inspect relevant `registry/<provider>/` implementations and tests. Calendar demonstrates terminal sync-token promotion; Slack fixed timestamp frontiers and retained threads; Meet late artifacts and nested cursors; Attio/Circleback completed-parent scans; GitHub/Linear complete discussion windows; Lemlist completed intervals. Reuse the invariant, not provider-specific dates, budgets, or account assumptions. Consult Brain's provider implementations when available while keeping its application projections out of raw registry schemas.

## Keep progress recoverable

- Bind stream IDs and saved state to stable non-secret source, account, and query identities. Check authenticated identity when the provider exposes it; otherwise require new stream/destination identities when switching accounts. Credentials themselves must not become checkpoint scope. Validate saved types, bounds, parent positions, and scope before reuse. Version custom strategies and document migrations.
- Separate completed coverage from unfinished work. Persist fixed window bounds and enough scoped page/parent/child position to resume them; recomputing a cutoff must not move an unfinished selection. Preserve exact provider timestamp precision and handle equal timestamps without skipping records.
- Yield fresh, complete candidate state. The executor owns its durable commit after destination evidence. Never advance a watermark past rows or required work that is neither loaded nor durably retained. Empty terminal pages and successful empty scans must also checkpoint completion. Use state-only markers or batching that flushes safe boundaries.
- Persist offsets or opaque page tokens only under a documented resumption contract. Expiring page tokens can be saved while valid if state also retains the original input and a safe recovery path. For mutable offset lists, restart the unfinished parent/interval at zero; skip acknowledged parents only within the saved scan cycle. Frozen selection means unchanged predicates and retained discovered parent IDs, not a frozen source dataset. Coverage still depends on provider ordering, snapshots, or eventual stability plus reconciliation. A completed cycle resets parent progress and discovers current parents again.
- On an expired token, replay the same scoped collection from its committed input or rebuild a baseline as the provider requires. Bound protocol resets across the unfinished selection, not just one process: retain reset debt or detect repeated recovery without useful durable progress. Repeated rejection/stalled recovery fails visibly. Keep existing raw observations during baseline recovery. Absence from a rebuilt baseline is not automatically deletion.
- Treat explicit backfills as separate checkpoint namespaces. Honor both bounds or reject unsupported bounds explicitly. Retain the original unfinished bounds, reject incompatible reuse of a backfill ID, and prevent interval watermarks from regressing. A bundled helper ignoring `range` does not establish a source's historical-range behavior.

## Preserve raw data and delayed children

Store complete returned objects as raw JSON with stable source/parent/provider keys; preserve sparse cancellation payloads. Keep application projections separate. For large child collections, prefer independently paged raw child rows over unbounded nested buffering. Each stream must discover its own parents; stream order is not a dependency contract.

A child failure must not publish an incomplete embedded document as complete. Either finish the required children first, or emit raw parent/child observations with durable pending work and explicit completion semantics. Retain relevant parents for delayed recordings/transcripts, and periodically revisit old roots when edits or replies do not update the discovery timestamp. Choose overlap and reconciliation cadence from provider retention, delay, volume, and freshness requirements.

Bound pending queues and in-memory work; fail visibly rather than silently dropping entries. Pending work that expires before collection is a coverage gap. Distinguish unavailable, forbidden, not-found, and still-processing outcomes using provider evidence. Diagnostics are not a retry queue unless the reader actually executes them.

Mutable row chunks should normally omit explicit chunk IDs so changed observations remain eligible for publication. Stable page numbers, offsets, cursor strings, and interval labels can suppress changed replay content. Explicit data-bearing IDs require immutable, repeatable content; state-only progress markers may use logical boundary IDs. Stable row IDs handle repeated observations, separately from batch deduplication.

Raw destinations retain latest observed records unless a stronger current-state protocol exists. Consume explicit deletion signals when supported. Do not infer deletion from partial, failed, inaccessible, or expired scans. Removing unseen records requires a separately designed completed-generation reconciliation.

## Bound execution and prove recovery

Use executor request/retry/cancellation authority with finite request timeouts. Validate repeated or malformed continuations and absent required terminal tokens. Classify provider-specific rate limits, permanent permission failures, and recoverable protocol resets correctly. Bound chunk sizes and expensive runs; ensure a run budget can reach a useful checkpoint, or partition the selection rather than perpetually replaying an oversized bootstrap.

Use portable fixtures through `runIngestion` with memory journal/destination adapters. Exercise the applicable contracts:

- Interrupt or exhaust a budget mid-window, page, parent, or child; deserialize saved state in a fresh run and verify complete eventual coverage under the original bounds.
- Accept destination rows, then lose the load acknowledgement or fail journal publication; verify replay without skipped rows or an advanced completed frontier. Reader-only tests cannot prove this ordering.
- Commit empty input and empty terminal progress; continue across empty pages that still have a cursor; reject repeated/malformed pagination and malformed or scope-mismatched saved state.
- Expire provider tokens, retain the correct input token across pages, and promote terminal tokens only after writes. Verify bounded recovery instead of an endless reset.
- Cover timestamp ties, exact precision, inclusive/exclusive bounds, overlapping runs, late children/old edits, parent discovery changes, and explicit backfill isolation where supported.
- Replay mutable observations with changed content and unchanged provider IDs. Test child failure/availability/retention behavior instead of silently truncating a document or queue.

Mark distributed fixture files with `role: "test"`, include their dependencies, and keep them free of repository-only imports and live credentials. For new packaging or destination changes, verify installed consumers and real ClickHouse JSON/replay behavior in an authorized isolated target; memory adapters do not establish merge or deduplication-window behavior.

Before delivery, align manifest labels, README, and integration guide with implemented coverage, bootstrap, normal sync, resumption, reconciliation, deletion semantics, account changes, backfill support, and tuning. Preserve immutable historical artifacts; bump template versions for changed source and document row/state identity changes. Report the evidence and remaining API limits.
