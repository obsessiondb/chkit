# chkit Public Docs

This folder contains the public documentation website for chkit, powered by Astro + Starlight.

Public docs content lives in `src/content/docs/`.

## Product documentation

Schema Management is the main product, starting at `/getting-started/`. Its guides, configuration, plugins, and CLI reference cover schemas and migrations without depending on Sync documentation. Python support is in beta; the backfill plugin is in beta.

chkit Sync (beta) syncs business application data into ClickHouse. It starts at `/sync/` and has its own getting-started, integrations, source authoring, operations, and reference hierarchy. It may link to Schema Management for destination definitions and migrations.

`astro.config.mjs` defines both product hierarchies. `src/route-data.ts` selects one sidebar per page and prevents pagination across products. The sidebar product picker switches between them. `src/data/docs-products.ts` assigns existing `/api-sync/`, `/integrations/`, ingestion command, and ingestion plugin URLs to Sync so published links remain valid. New Sync pages belong under `sync/`; add them to its sidebar in the config. Keep schema-only plugin and CLI entries explicit so Sync commands do not enter the schema menu. Product naming changes in the docs do not rename `chkit ingest`, npm packages, or the installed `chkit-ingestion` agent skill.

The previous `/ingestion/` product landing and CLI overview redirect to `/sync/` and `/sync/cli/`. Astro emits HTML redirect pages for local previews; the Pages middleware redirects both HTML and Markdown URLs in production. Older `/ingestion/` source-authoring guides still redirect to their `/api-sync/` equivalents.

Search is scoped to the current product. `Head.astro` adds Pagefind product metadata, and `Search.astro` applies the matching filter before the first query. `src/data/docs-search.ts` shares the scope rules between indexing and the search UI; blog search uses its own scope. The search override preserves Starlight's modal, shortcuts, translations, and styling.

The Sync landing diagram lives in `src/components/SyncFlow.astro`. It uses responsive HTML/CSS and SVG connectors with original provider artwork from `public/logos/`; source links are recorded in that directory's README. Keep the artwork separate from the diagram so logos stay sharp and retain their original proportions.

The homepage and package READMEs introduce schema management; a short beta paragraph at the bottom links to Sync. The generated Markdown index and `llms.txt` group documentation by product.

Internal planning/spec documents are intentionally kept in the repository-level `/docs` folder and are not part of this site by default.

## Commands

- `bun run docs:dev` (from repo root): start local docs server at `localhost:4321`
- `bun run docs:build` (from repo root): build production docs site

## Preview feedback

[Agentation](https://agentation.dev) is enabled in the local dev server and PR preview deployments. Open its toolbar in the bottom-right corner to annotate the page and copy feedback.

CI sets `PUBLIC_AGENTATION_ENABLED=true` only for the preview build. To build the same version locally, run `PUBLIC_AGENTATION_ENABLED=true bun run docs:build`. Standard production builds leave the overlay disabled. Turbo includes the flag in the docs build cache key.
