---
title: "Automatic data-ops for ClickHouse® database"
description: "How chkit's backfill plugin chunks, resumes, and de-duplicates large ClickHouse reingestions automatically, and runs them locally or as a managed job."
date: 2026-07-02
authors: alvaro
excerpt: "We killed a 20-million-row reingestion a third of the way through, then resumed it to exactly 20,000,000 rows. The automatic, resumable, idempotent way to run heavy reingestion and backfill jobs on ClickHouse, locally or as a managed job."
cover:
  alt: "A ClickHouse source table planned into balanced chunks."
  image: ../../../assets/blog/00-social-card.png
tags:
  - clickhouse
  - backfill
---

We killed a 20-million-row reingestion a third of the way through. Not gracefully. We sent the process a hard kill mid-run, the way a closing laptop lid or a timed-out CI runner would. Then we ran one command to resume. It finished the rest in 25 seconds and landed exactly 20,000,000 rows in the target. Not one lost. Not one duplicated.

That recovery is the whole point, so I'll come back to it. First, the problem it solves.

If you've ever had to move a large table on ClickHouse®, you know the shape. You changed a sort key, or added a column, or fixed a materialized view, and now a few billion rows have to be rewritten to match. The reflex is one big `INSERT ... SELECT`. On anything real, that reflex tips the cluster over.

## The trap isn't the insert. It's the loop.

A single statement rewriting billions of rows fights your read traffic for memory, drags on background merges, hits a memory limit, and dies. It dies at 80%, with no checkpoint, so you start again from zero. You retry, and because the insert isn't idempotent, half the rows are now duplicated. The entire time you have no real idea how far along it got. You're in another terminal running `SELECT ... FROM system.processes`, squinting.

So you do the sensible thing. You chunk it. Split the range, loop, insert one slice at a time.

Here is where it gets you. The chunk loop is the actual work. To do it properly, you have to choose boundaries that keep each slice under a memory budget, which means reading the data distribution, which means dealing with skew when a single value owns half the table. You have to make each chunk idempotent so a retry doesn't duplicate. You have to persist progress so a crash doesn't cost you the run. You have to poll for completion, catch failures, and surface progress somewhere. That's a small system. Most teams write it once, under a deadline, a little wrong, and then maintain it forever.

We know that loop well. At Numia, we ran petabytes of on-chain data on ClickHouse, and reingestion was just part of the week. A schema change, a fixed materialized view, a chain we had to pull again from an early block, and a few billion rows had to move to match. So we wrote the chunk loop. Then we wrote it again for the next table. We wrapped it in a script, bolted on resume after a run died overnight and cost us the progress, and kept patching it from there. It was never the interesting work. It just sat in front of all the interesting work.

We got tired of writing that system. So CHKit's backfill plugin writes it for you, and the same plan can either run from your machine or be handed to our platform to run as a managed job. It's open source, MIT, and it runs against ClickHouse Cloud, ObsessionDB, or a self-hosted ClickHouse cluster.

## Point it at a ClickHouse table, get a backfill plan

You start with a plan. Give it a table and a size budget per chunk:

```sh
chkit backfill plan --target analytics.events --max-chunk-bytes 2G
```

CHKit reads the table's partitions and sort keys and works out the chunk boundaries itself. Partitions are the first cut. Any partition over the budget gets cut again along the sort key, and it chooses how based on the data: a numeric key gets quantile ranges, a time column gets time buckets, and a skewed key where one value dominates gets split on the next sort-key column, so that hot value doesn't collapse into one enormous chunk. You compute none of this. You get back an immutable plan, a list of chunks, each roughly the size you asked for.

Does that hold up on real data? We pointed it at `wikicold`, a 4.23-billion-row table on our benchmark cluster, with a 2 GiB budget. It planned 89 chunks across 28 partitions in about 69 seconds. The chunks came out even: 1.7 GiB on average, 2.18 GiB at the largest, all sitting near the target. Nothing tuned by hand.

![A 4.23-billion-row source table planned into 89 balanced chunks, each near the byte budget, with idempotent and resumable execution.](/blog/02-auto-chunking.png)

The plan is just context, nothing has run yet. That's deliberate, because the plan is what both execution paths consume.

## Safe to interrupt, safe to retry

Now run it:

```sh
chkit backfill run --plan-id <id>
```

This is where the loop you didn't write earns its keep. Three things happen without you asking.

Every chunk is idempotent. Each one carries a deterministic dedup token built from the plan and chunk id, so ClickHouse drops a duplicate block if the same chunk lands twice. Retry a chunk, re-run the whole plan, run it twice in your sleep: the row count does not move. The duplicate problem isn't solved by you being careful. It can't happen.

The chunks run as async queries with deterministic IDs, and their progress is read back from `system.query_log`. There's nothing to babysit in a terminal. The run bounds its own concurrency and polls each chunk to completion.

And a run is resumable. Progress checkpoints to disk, and resume does something slightly paranoid before it continues: it reconciles with the server first. It checks which chunks genuinely finished, including any that completed on the cluster but never made it into the local checkpoint, and runs only what's actually left. `--replay-failed` re-runs the ones that errored.

None of that is a flag you have to remember. Idempotency, checkpoints, the reconcile step: they are the defaults, because the one promise a reingestion has to keep is that you can walk away and come back to it. We built for the version of you at 4am staring at a half-finished run, not the one reading the docs on a calm afternoon.

Back to the number from the top. We planned 20 million rows into 15 chunks, killed the process after 5 finished, and the target held about 10.8 million rows, a partial state. Then:

```sh
chkit backfill resume --plan-id <id>
```

25.5 seconds later, the target had exactly 20,000,000 rows. We re-ran the entire plan on top of that, all 15 chunks again, and the count stayed at 20,000,000. Resume finished the work. Idempotency made the redo a no-op.

## One algorithm, two places to run it

Everything so far runs from your laptop, against any ClickHouse cluster you point it at. That's the plugin most people will use, `@chkit/plugin-backfill`, and it has no idea ObsessionDB exists.

There's a second plugin, `@chkit/plugin-obsessiondb`, also open source, that imports the same planner. The difference is one verb:

```sh
chkit backfill submit --target analytics.events
```

![One backfill plan, run two ways: `backfill run` executes locally against any ClickHouse cluster, `backfill submit` hands the same plan to the ObsessionDB job system to run server-side.](/blog/01-two-venues.png)

Instead of running the chunks from your machine, `submit` hands the plan to the ObsessionDB job system. The chunks run server-side, on our infrastructure, and you get back a link to the job in the console. You watch it there instead of holding a terminal open. Same plan, same chunk SQL, same dedup tokens. The only thing that changes is where the work runs, and who has to babysit it, which is now nobody.

When we tried this against a service on the benchmark cluster, `submit` built the plan, sent four tasks to the backend, and all four ran to completion server-side, tracked by the console link. The row count held. Same idempotency, because it's the same SQL.

Here's that job in the console. Progress, rows read and written, throughput, and a row per task with its own duration and byte counts. A task that fails gets retried from here, not from a terminal you left open. It sits next to your services, monitoring, and alerts, the same place you already watch the database.

![The ObsessionDB console showing the submitted backfill job: 100% complete, 4 of 4 tasks done, with per-task read, written, and throughput.](/blog/03-console-job.png)

We could have written a separate cloud backfill, tuned to our own infrastructure. We deliberately didn't. The managed path imports the same planner the open-source one uses, runs the same SQL, and stamps the same dedup tokens. The moment those two diverge, the way it behaves on your laptop stops predicting the way it behaves on ours, and that is exactly when people stop trusting a tool. Shared, boring internals were the point.

Here's the honest split. The code is open source and free; the capability is for customers. Submitting a job needs an ObsessionDB service to submit it to. Running locally needs nothing from us. The managed path is there for the backfills that are too big or too long-running to babysit from a terminal.

## Where you'd reach for it

Reingesting after a schema change is the obvious one, and it's what we've been describing. A few others share the shape. Recomputing a materialized view after you've changed its definition, where the backfill runs the insert through the view's own `SELECT`. Pulling a dataset in again from scratch. Backfilling a window of derived data after fixing the bug that computed it wrong the first time. Any repeatable bulk copy where you'd otherwise be maintaining that hand-rolled loop.

## Reingestion is the first job. The platform is the bet.

The managed path isn't a hosted copy of the CLI. It's the first customer-facing piece of a job system we've been building inside ObsessionDB, the thing that moves large amounts of data around on our own clusters.

Reingestion is the first job type we opened up, but the shape is general. A materialized-view recompute is the same problem. So is a bulk import from a bucket, pulling a source in from scratch, or backfilling a window after a fix. Every one of them is a large amount of data that has to move, safely, on demand or on a schedule, without a person babysitting a terminal.

The bet is straightforward. Easy, repeatable data operations are what separate a managed database from a cheaper one. Performance and price get you in the door. But if a team can recompute a model, backfill a fix, and re-ingest a source several times a day without touching infrastructure or hand-writing a chunk loop, that gets hard to give up.

`backfill submit` is step one. Your reingestion runs on our infrastructure, and you watch it in the console. What comes next is the rest of the job types, and a way to author and track them without touching the CLI at all.

## The rule I'd save

If a job is a one-off and fits inside one sitting: run it locally. If it's large, long-running, has to survive your laptop closing, or you want it tracked and repeatable: submit it. Local for the quick jobs. Submit for the ones you don't want to hold in your hands.

## Try it

The backfill plugin is on [GitHub](https://github.com/obsessiondb/chkit) and npm:

```sh
bun add -d @chkit/plugin-backfill
```

It's MIT, and it runs against ClickHouse Cloud, ObsessionDB, or a self-hosted ClickHouse cluster (single-node support is on the way). It's beta: the core commands are stable, small breaking changes are possible before 1.0, and the `submit` path is new, we shipped it this week. We run backfill in production for customer reingestion, which is where most of these gotchas came from in the first place.

For the managed path, add `@chkit/plugin-obsessiondb` and spin up a free service at [console.obsessiondb.com](https://console.obsessiondb.com/?utm_source=chkit_blog&utm_medium=blog&utm_campaign=reingestion).

Full command reference lives in the [backfill docs](https://chkit.obsessiondb.com/plugins/backfill/). And if you haven't seen the schema side of CHKit, the [schema-as-code post](https://obsessiondb.com/blog/clickhouse-schema-as-code) covers how the tables themselves become code.