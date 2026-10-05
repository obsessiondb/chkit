# GitHub raw ingestion example

This is a small editable starting point based on the GitHub source in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync). It stores provider responses as native JSON without Brain's memory or sales projections.

Set `GITHUB_TOKEN` in the runtime environment and configure a direct ClickHouse connection. Edit `githubConfig.repositories` in `config.ts` before the first run. Raw table names and database live in `sources/issues.ts` and `sources/stargazers.ts`; edit those declarations before the first migration. Native JSON requires ClickHouse 25.3 or later.

`pipeline.ts` groups one issues stream and one stargazers stream per configured repository in a single pipeline. Each stream owns its own progress and reads only that repository's collection. The default stream IDs remain `github.issues.obsessiondb.chkit` and `github.stargazers.obsessiondb.chkit`. `createGitHubPipeline(config, deps)` binds source configuration and an injectable `fetch`/token reader; changing `sourceId` creates new stream identities. Destination schemas remain the module exports rather than runtime configuration.

```sh
bunx chkit check
bunx chkit generate --name add_github
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:github
```

## Resources

- `issues` → `github_issues_raw`
- `stargazers` → `github_stargazers_raw`

## Sync and recovery

Issues use `since`, `sort=updated`, and `direction=asc`, then discard observations newer than the fixed execution cutoff. The initial scan starts at `2008-01-01`; later scans replay five minutes before the last committed watermark. GitHub has no `until` filter: following `Link` continuations over changing results is best-effort polling, not a source snapshot. The watermark advances only after the complete issue window and all its destination writes succeed. Failed windows start again from their lower bound; no page number is saved.

Each issue includes all returned issue-comment pages. Pull requests additionally include detail, reviews, review comments, commits, and files. The provider can cap commits or files; `_chkit_context.commits_complete` and `files_complete` compare returned counts with the detail response. A child-request failure prevents publishing that parent and advancing the window. GitHub tokens need read access to issues and pull requests for this context.

Stargazers use the built-in `fullSync` strategy and read from the beginning on each run. The ingestion journal records successful stream completion, including an empty read, without custom scan state. Both resource readers use `paginate` for retryable pages and continuation cycle detection. Removed stars and deleted issues remain stored. Child-only changes may not update the parent issue, and offset pagination can miss records under concurrent mutations. Periodically replay the issue history using a new backfill ID, or supplement polling with a durable webhook integration:

```sh
bunx chkit ingest run --tag provider:github --tag resource:issues --backfill reconcile-2026-10-04 --from 2008-01-01
bunx chkit ingest status --tag provider:github --json
```

This re-reads current observations by their last-update timestamp; it does not reconstruct historical versions. Reusing an ID addresses that backfill's checkpoint namespace. Raw payloads keep provider fields, and mutable observations intentionally have no declared chunk ID so a changed replay is not suppressed by a page identity. Run one ingestion process per ClickHouse target at a time.

Select one repository and resource without running the other streams:

```sh
bunx chkit ingest run --tag provider:github --tag repository:obsessiondb/chkit --tag resource:issues
```

The pipeline's default `maxStreams: 1` executes selected streams sequentially; separate filtered runs provide independent schedules and execution budgets. A failed stream does not advance another stream's checkpoint. Keep `sourceId` tied to one authenticated installation, and start a new identity when replacing its scope.

## Fixture tests

```sh
bunx chkit add github --with-tests
bun test src/integrations/github/tests/basic.test.ts
```

The portable suite covers configuration binding, independent repository/resource selection, continuation links, cutoff filtering, PR context, replay after source/sink failures, overlap and empty full-sync completion without live credentials.
