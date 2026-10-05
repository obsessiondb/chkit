# GitHub raw ingestion

This editable integration syncs eight GitHub resource collections into separate raw ClickHouse tables. One installation pipeline groups the streams; each resource owns its selection and journal progress.

## First run

Set `GITHUB_TOKEN` in the runtime environment and configure a direct ClickHouse connection. For private repositories, the supported setup grants repository access with **Issues: read**, **Pull requests: read**, and **Contents: read** permissions, including GraphQL commit reads. These permissions describe the supported setup; field-level minimum permissions depend on the selected endpoints and GraphQL fields. Requests read credentials at execution time; schema imports do not call GitHub. Native JSON requires ClickHouse 25.3 or later.

Edit `githubConfig.repositories`, `sourceId`, timestamp settings, and `pageSize` in `config.ts`. Raw table names and database are declared in their `sources/` modules; edit those definitions before the first migration. `createGitHubPipeline(config, deps)` snapshots reader settings and binds an injectable fetch/token reader. Destination schemas remain setup-time module exports.

```sh
bunx chkit check
bunx chkit generate --name add_github
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:github
```

## Pipeline and resources

Each configured repository contributes eight independently selectable streams to `githubPipeline`:

| Resource tag | Raw destination | Selection |
| --- | --- | --- |
| `resource:issues` | `github_issues_raw` | Updated-time window; excludes pull requests |
| `resource:issue_comments` | `github_issue_comments_raw` | Comment updated-time window, with its own issue discovery |
| `resource:pull_requests` | `github_pull_requests_raw` | Full pull-request collection |
| `resource:pull_request_comments` | `github_pull_request_comments_raw` | Conversation-comment updated-time window, with its own PR discovery |
| `resource:pull_request_review_comments` | `github_pull_request_review_comments_raw` | Repository-wide diff-comment updated-time window |
| `resource:pull_request_reviews` | `github_pull_request_reviews_raw` | Full reviews collection, with its own PR discovery |
| `resource:pull_request_commits` | `github_pull_request_commits_raw` | Full PR commit connections, with its own PR discovery |
| `resource:stargazers` | `github_stargazers_raw` | Full stargazer collection |

The default repository is `obsessiondb/chkit`, so its stream IDs use `github.<resource>.obsessiondb.chkit`. Existing issues and stargazers stream IDs remain unchanged. Another repository gets independent stream identities and checkpoints. Keep `sourceId` stable for one installation; changing it creates new stream identities.

Select a resource without running any other stream:

```sh
bunx chkit ingest run --tag provider:github --tag repository:obsessiondb/chkit --tag resource:pull_request_commits
bunx chkit ingest run --tag provider:github --tag repository:obsessiondb/chkit --tag resource:pull_request_comments
```

Repeated tags use AND matching. The default `maxStreams: 1` executes selected streams sequentially; filtered runs give resources separate schedules and execution budgets. Stream order does not establish dependencies. A child reader discovers its own accessible parents through GitHub, even when the issues or pull-requests stream has never run. Individual issues and PRs are records inside their resource stream.

## Stored data and joins

Every raw payload has the envelope `{ repository, data }`. Issue comments add `issue_number`; PR conversation comments, review comments, reviews, and commits add `pull_number`. Provider response fields remain under `data`. Issues and PRs contain their own metadata, while comments and reviews occupy individual rows in their respective tables.

PR commits retain exactly `data.sha` and `data.message`, plus the repository and PR join keys. The reader requests the paginated [GraphQL PR commit connection](https://docs.github.com/en/graphql/reference/pulls#pullrequest) and maps the provider commit object ID to `sha`. Repeated SHAs, changes in `totalCount`, or a mismatched distinct terminal count fail the commit stream rather than completing a truncated collection. It does not request changed files or patches.

Join resources later in ClickHouse using `repository` plus `data.number` on issues/PRs and `issue_number` or `pull_number` on child rows. Review comments also retain their provider review ID for joining to reviews. A commit's SHA is scoped to its repository/PR membership, so a commit appearing in several PRs remains joinable to each one.

Raw IDs retain provider identities and parent context. Existing issue and stargazer ID formats stay `[repository, issue.number]` and `[repository, user.id]`. The tables retain the latest observed payload per identity, with ingestion metadata added by chkit.

## Sync and recovery

Issues use `since`, update-time ordering, and a fixed local upper cutoff. Issue comments and PR conversation comments use their own `since` filters; their parent discovery reads the entire accessible issue or PR collection without restricting parent modification times. A recent comment on an old issue or PR stays eligible. Repository-wide review comments use their own update-time filter and recover the PR number from `pull_request_url`. See [issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments) and [review comments](https://docs.github.com/en/rest/pulls/comments#list-review-comments-in-a-repository).

The initial timestamp window starts at `2008-01-01`; later windows replay five minutes before the committed watermark. GitHub has no server-side upper timestamp filter for these REST reads, so each timestamp reader discards observations newer than the fixed execution cutoff. A stream advances its watermark only after its complete window and destination writes succeed, including empty windows. Failed or interrupted windows replay from their lower bound.

Pull-request metadata, reviews, PR commits, and stargazers use the library's `fullSync()` strategy. Every run reads that selected resource again; the journal records successful completion, including empty reads. Interrupted reads start the selected collection from its beginning. There are no saved mutable page offsets or per-parent scan ledgers. REST `Link` URLs and GraphQL cursors are request continuations within the read; `paginate()` owns retryable requests and rejects cycles.

Deleted records, removed stars, and commits no longer present after force-pushes remain stored. Pagination over live results is not a source snapshot; periodic historical replay refreshes older timestamp-selected observations and changes beyond overlap:

```sh
bunx chkit ingest run --tag provider:github --tag resource:issue_comments --backfill reconcile-2026-10-05 --from 2008-01-01
bunx chkit ingest status --tag provider:github --json
```

Use a new backfill ID for each reconciliation. Historical replay reads current observations rather than reconstructing old versions. Full-sync resources ignore date bounds. A failed stream can have published some rows without completing its journal progress; it does not move another stream's checkpoint. Run one ingestion process per ClickHouse target at a time.

## Upgrading existing data

Version `0.2.0` adds six raw destinations and separates issues from pull requests. The raw envelope changes to `{ repository, data }` while existing issue/stargazer row IDs stay stable. Previously stored flat payloads may coexist with new envelopes until their IDs are observed again or migrated explicitly.

Combined-reader installations may also have PR rows in `github_issues_raw` and child arrays embedded in parent JSON. Those observations remain stored; running the new streams does not remove or move them. Keep the previous dataset as an archive, or deliberately migrate issue/PR classifications and child payloads into their separate destinations. In particular, old PR rows remain in the issues table until an explicit data migration or reconciliation removes them. Application queries need to account for both retained legacy shapes and the new envelope during that transition.

## Fixture tests

```sh
bunx chkit add github --with-tests
bun test src/integrations/github/tests/basic.test.ts
```

Portable fixtures verify resource selection and failure isolation, raw payloads and join keys, commit field selection, old-parent child updates, pagination continuations, source/sink failure recovery, configuration snapshots, and empty completion without live credentials.
