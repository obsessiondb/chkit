# GitHub raw ingestion example

This is a small editable starting point based on the GitHub source in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync). It stores provider responses as native JSON without Brain's memory or sales projections.

Set `GITHUB_TOKEN` in the runtime environment and configure a direct ClickHouse connection. Edit `repositories` in `index.ts` before the first migration. Native JSON requires ClickHouse 25.3 or later.

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

Stargazers always perform a full scan. Their checkpoint's `completedAt` records a successful scan, including an empty one; it is not an incremental star cursor. Removed stars and deleted issues remain stored. Child-only changes may not update the parent issue, and offset pagination can miss records under concurrent mutations. Periodically replay the issue history using a new backfill ID, or supplement polling with a durable webhook integration:

```sh
bunx chkit ingest run --tag provider:github --tag resource:issues --backfill reconcile-2026-10-04 --from 2008-01-01
bunx chkit ingest status --tag provider:github --json
```

This re-reads current observations by their last-update timestamp; it does not reconstruct historical versions. Reusing an ID addresses that backfill's checkpoint namespace. Raw payloads keep provider fields, and mutable observations intentionally have no declared chunk ID so a changed replay is not suppressed by a page identity. Run one ingestion process per ClickHouse target at a time.

## Fixture tests

```sh
bunx chkit add github --with-tests
bun test src/integrations/github/tests/basic.test.ts
```

The portable suite covers continuation links, cutoff filtering, PR context, replay after source/sink failures, overlap and empty full-scan completion without live credentials.
