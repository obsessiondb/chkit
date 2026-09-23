# Ingestion authoring: internal review

Prepared for Marc, 2026-09-20. This review stays outside the published docs. Customer guidance appears beside the relevant implementation step, beginning with the simplest example and introducing extensions only when needed.

**The brain has eight provider raw tables.** Provider-specific SQL views expose those records. A later TypeScript projection builds the single `brain.memory` document table for retrieval, read through `memory_current`. Use that combined table for the brain's retrieval model; use entity or event tables for warehouse analytics. [Entry exports][B19], [provider schema][B1], [memory pipeline][B2], [memory schema][B3].

Evidence below describes the current local files in `/Users/marc/Workspace/chkit-ingest/brain-sync`. The directory is untracked in its parent checkout. I did not verify deployment state or scheduler operation. The recommendations assess fit. They do not establish the original implementation rationale.

## The main choices

| Choice and recommendation | What brain sync implements |
|---|---|
| **Store raw and transform in ClickHouse, or map first into a known schema.** Prefer raw when the final shape may change and storage is affordable. Prefer mapping when entity schemas are established or retaining unused fields creates material storage/ingestion cost. Transformation location is part of this choice. | Provider responses go into native JSON raw tables, with typed ordinary SQL views. The unified memory projection then maps retained records into its own schema. Linear retains the fields selected by its GraphQL query. [B1], [B3], [B4] |
| **Embed a root's children, or store related entities separately.** Embed bounded comments/transcripts when the consumer needs a complete document. Use entity tables and relationship keys for independent child queries/updates. A warehouse can selectively denormalize for its common queries; structured does not mean fully normalized. | GitHub/Linear embed discussions. Attio keeps meetings and recordings separately, with transcripts embedded in recordings. Meet keeps conferences and transcripts separately, attaching participants/entries. Memory later assembles complete documents. [B5], [B6], [B8], [B9] |
| **Keep current state or retain history.** Current-state tables replace versions under one stable object key. History needs a stable event/revision identity so earlier versions survive. | Raw and memory tables use current-state replacement by ingestion time, with `FINAL` in their query views. Raw retention supports later remapping of the retained snapshot; it does not preserve a complete change history. [B1], [B3], [C1] |
| **Read everything or fetch changes.** Start with a full sync for small, bounded datasets. Use timestamp filters or a durable provider change token when complete reads become expensive. A page cursor is not automatically resumable across runs. | Both full syncs and timestamp windows, depending on the source. No durable cursor strategy or custom incremental strategy. Memory scans retained raw data and writes only changed document hashes. [B7], [B8], [B9], [B16], [B2] |
| **How are deletes discovered?** Prefer tombstones for logical deletion in current-state tables. Read deletion signals explicitly. Without them, a complete authoritative reconciliation scan requires application implementation. An incomplete scan never establishes a deletion. | Deletion detection and tombstones are not implemented. Missing records remain, and stars represent historically observed stargazers. New sources should implement deletion discovery and tombstones. [B10] |
| **Keep the default loader unless publication needs to change.** Raw versus typed rows and nested objects do not require different loaders. Insert-size tuning is a later step. | Every stream omits `loader`, selecting `simpleLoader()`. The memory projection also uses it. Publication is per batch, with no atomic corpus replacement. [B2], [B7], [B8], [B9], [B16], [C4] |

Customer placement: the first three choices and tombstones sit in [Destinations and transformations][D1]. Fetching children is explained in [Readers][D2], full reads precede time/cursor examples in [Incremental syncs][D3], and [Loading][D4] starts with the default. There is no public inventory page.

## How nested loading works in the brain

The reader assembles nested objects in application code:

1. Discover a root object, such as an issue or meeting.
2. Fetch its required child pages through `paginate`/`context.attempt`.
3. Attach the fetched collections and yield the completed object with `rawRows`.
4. The default loader writes that row to the stream's single destination.

GitHub joins comments and PR context before yielding. Linear follows nested comment cursors before yielding an issue. Attio joins transcript segments into recordings; Meet attaches conference, participant, and transcript-entry data. A required child failure must fail the root fetch rather than publish a partial object as complete. [GitHub][B5], [Linear][B6], [Attio][B8], [Meet][B9].

The later memory stream reads all retained raw sources, assembles Markdown documents and relationships, and writes changed content hashes. It runs after the selected raw streams succeed. This is a document-retrieval requirement of the brain; normal warehouse examples should start with entity/event tables. [Projection][B2], [sequencing][B17].

For separate child tables, each stream has its own destination and checkpoint. The child reader needs a discovery path, potentially enumerating parent IDs itself. Exporting parent and child streams does not create an execution dependency. [Stream definition][C8], [entry][B19].

## Actual source selections

| Stream(s) | Read strategy and first lower bound | Overlap | Cadence tag | Load batch size |
|---|---|---|---|---|
| Attio meetings | Timestamp; `2024-01-01` | 14 days | `schedule:12h` | Default 10,000 |
| Attio call recordings | Timestamp; `2024-01-01` | 14 days | `schedule:12h` | 200 |
| Attio people / companies | Full sync | n/a | `schedule:1d` | 2,000 |
| GitHub issues / PRs, per repository | Timestamp; `2008-01-01` | 5 minutes | `schedule:6h` | Default 10,000 |
| GitHub stargazers, per repository | Full sync, token required | n/a | `schedule:1d` | Default 10,000 |
| Linear issues | Timestamp; Unix epoch | 5 minutes | `schedule:6h` | Default 10,000 |
| Meet conferences / transcripts | Timestamp; `2024-01-01` | 7 days | `schedule:12h` | 500 / 100 |
| Memory documents | Full raw scan; emit changed hashes only | n/a | `memory` | 100 |

Evidence: [Attio][B8], [GitHub][B7], [Linear][B16], [Meet][B9], [memory][B2], [default batch size][C3]. Cadence tags select streams; they do not schedule them. Load batch size is a flush threshold, not a provider page or physical insert size.

The Attio and Meet comments explain their longer overlap windows: recordings/transcripts may appear later. Linear explicitly waits for the whole timestamp window because newest-first pages are not safe intermediate frontiers. None of the provider readers persists page cursors as checkpoints. [Attio][B8], [Meet][B9], [Linear][B16].

## Deletes and refresh: what exists

The recommendation is to retain a newer row with the same key and an `is_deleted` flag, then hide tombstoned versions from current-state queries. The docs now show this as a custom schema and reader example. It is not an automatic chkit behavior. Version ordering must prevent an older replay from reviving a deleted object. [Destination guide][D1], [ClickHouse replacement semantics](https://clickhouse.com/docs/concepts/features/operations/update/replacing-merge-tree).

Nango's guide separates explicit delete signals in incremental reads from full-scan comparison, and warns that an incomplete scan can falsely mark valid records deleted. Its full-scan tracking helpers are Nango features; chkit has no equivalent built in. [Nango deletion detection](https://nango.dev/docs/guides/functions/syncs/deletion-detection).

In chkit today:

- **Full sync** means rereading the source, not replacing the table or reconciling absent IDs. [Strategy][C2]
- **Brain memory rebuild** recomputes retained documents and skips unchanged hashes. It neither detects source deletions nor swaps the corpus atomically. [Projection][B2]
- **Source reconciliation / snapshot replacement** has no bundled implementation. A correct application implementation would need authoritative enumeration, completion tracking, scope isolation, and deliberate publication of tombstones after a successful scan.
- **ClickHouse refreshable views** are a separate SQL feature already documented in the schema area. They do not refresh provider data or discover missing source records. They are linked only as an advanced downstream option, not presented as an ingestion loader.

## Details to introduce only when needed

<details>
<summary>Implementation settings and extension points</summary>

These are tuning or provider-specific implementation details, rather than a checklist every customer must decide up front.

| Area | Brain choice; when alternatives matter |
|---|---|
| Requests and auth | Shared HTTP wrapper; provider credentials from environment; Google delegated tokens cached per user/scopes. Use an SDK only when it simplifies a required provider behavior. [B11], [B13] |
| Pagination | `paginate` handles provider cursors, offsets, and page numbers. Memory uses a manual `id > after` scan. Manual reader loops and durable cursor state are later examples when the actual source contract needs them. [B4], [B12], [B14], [B15], [B2] |
| Identity scope | GitHub streams/keys include repository; Attio records include object type. Meet deduplicates conferences across users inside two streams, without per-user checkpoints. [B7], [B8], [B9] |
| Physical inserts and batch identity | Default 50,000-row insert maximum; no explicit chunk IDs. Memory additionally suppresses unchanged content hashes. Explicit chunk IDs are only for stable logical intervals. [B2], [C7] |
| Concurrency | Attio and Meet: streams 2/fetches 3. GitHub/Linear: fetches 2 with default streams 4. Memory: 1/1. Loads stay at default 2 per pipeline; prefetch stays at 1. Tune after measuring capacity and working memory. [B7], [B8], [B9], [B16], [B2], [B18], [C5] |
| Retries | Attio: 5 retries, 500 ms–30 s; Meet: 6, 1–60 s. GitHub classifies rate-limited 403/429 responses specially. Provider errors justify overrides; ordinary sources begin with defaults. [B8], [B9], [B12] |
| Execution and code organization | Provider modules re-exported through one entry; CLI wrapper sequences raw then memory. Programmatic runtime is used in tests. Bare `ingest()` uses default journal/duration/buffering. [B19], [B17], [B18], [B20], [C6] |
| Advanced transformations | No materialized or refreshable views in brain schemas. A materialized target needs replay/update semantics and a rebuild plan; a separate application projection needs sequencing and bounded working memory. [B19], [B2] |
| Tests | Fixtures cover child pagination, identities/relations, Google retries/resumption, and memory failed writes/unchanged rebuilds. I did not run live provider or database checks for this review. [B20], [B22], [B23] |

</details>

## Brain-specific follow-up notes

1. **GitHub ignores the upper timestamp bound.** It passes only `selection.from` to `since`, so it may fetch beyond a scheduled or historical window. Review before using it as the bounded-window example. [B7], [B12]
2. **Child updates and deletes need discovery.** Parent timestamps may not reflect child edits; finite meeting lookbacks only revisit their interval. Brain notes call for periodic reconciliation, but it is not implemented as an automatic refresh feature. [B10]
3. **Memory retains the entire working dataset.** Reads use pages of 500, but raw rows and the hash index accumulate before projection. This is a current-dataset choice, not an unbounded warehouse pattern. [B2]
4. **Serialization is an operating rule.** The wrapper sequences stages but does not acquire a cross-process lock. Scheduler/lock enforcement remains unverified. [B17], [B21]

These findings do not change the brain-sync implementation.

## Skill and documentation division

The [concise skill][S1] uses the same two storage paths and asks for consequential source facts. It keeps correctness contracts and routes to the relevant guide. Detailed examples stay in the docs, progressing from simple defaults to optional extensions. The brain-specific comparison stays here.

TypeScript and a direct ClickHouse connection are current requirements. Custom loaders, strategies, and adapters are interfaces for application implementations, not extra bundled products. For warehouse modeling, distinguish separate typed entities from selective denormalization for a known query. [ClickHouse modeling guidance](https://clickhouse.com/resources/engineering/when-to-denormalize-when-to-join).

[D1]: /Users/marc/Workspace/chkit/apps/docs/src/content/docs/ingestion/destinations.md
[D2]: /Users/marc/Workspace/chkit/apps/docs/src/content/docs/ingestion/readers.md
[D3]: /Users/marc/Workspace/chkit/apps/docs/src/content/docs/ingestion/incremental-syncs.md
[D4]: /Users/marc/Workspace/chkit/apps/docs/src/content/docs/ingestion/loading.md
[D5]: /Users/marc/Workspace/chkit/apps/docs/src/content/docs/ingestion/quickstart.md
[D6]: /Users/marc/Workspace/chkit/apps/docs/src/content/docs/ingestion/operations.md
[D7]: /Users/marc/Workspace/chkit/apps/docs/src/content/docs/ingestion/testing.md
[S1]: /Users/marc/Workspace/chkit/skills/chkit-ingestion/SKILL.md
[B1]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/attio/schema.ts:5
[B2]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/memory/pipeline.ts:7
[B3]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/memory/schema.ts:5
[B4]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/linear/client/index.ts:19
[B5]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/github/client/index.ts:84
[B6]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/linear/client/index.ts:66
[B7]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/github/pipeline.ts:6
[B8]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/attio/pipeline.ts:6
[B9]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/google-meet/pipeline.ts:7
[B10]: /Users/marc/Workspace/chkit-ingest/brain-sync/MEMORY.md:69
[B11]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/lib/http.ts:11
[B12]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/github/client/index.ts:17
[B13]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/google-meet/client/auth.ts:22
[B14]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/attio/client/index.ts:22
[B15]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/google-meet/client/index.ts:53
[B16]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/linear/pipeline.ts:6
[B17]: /Users/marc/Workspace/chkit-ingest/brain-sync/scripts/sync.ts:1
[B18]: /Users/marc/Workspace/chkit-ingest/brain-sync/clickhouse.config.ts:4
[B19]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/chkit.ts:1
[B20]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/memory/pipeline.test.ts:6
[B21]: /Users/marc/Workspace/chkit-ingest/brain-sync/README.md:51
[B22]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/context.test.ts:19
[B23]: /Users/marc/Workspace/chkit-ingest/brain-sync/src/providers/google-meet/pipeline.test.ts:74
[C1]: /Users/marc/Workspace/chkit/packages/plugin-ingest/src/destination.ts:35
[C2]: /Users/marc/Workspace/chkit/packages/plugin-ingest/src/incremental.ts:37
[C3]: /Users/marc/Workspace/chkit/packages/plugin-ingest/src/executor.ts:30
[C4]: /Users/marc/Workspace/chkit/packages/plugin-ingest/src/executor.ts:445
[C5]: /Users/marc/Workspace/chkit/packages/plugin-ingest/src/registry.ts:93
[C6]: /Users/marc/Workspace/chkit/packages/plugin-ingest/src/plugin.ts:24
[C7]: /Users/marc/Workspace/chkit/packages/plugin-ingest/src/loader.ts:9
[C8]: /Users/marc/Workspace/chkit/packages/plugin-ingest/src/registry.ts:21
