# chkit Public Docs

This folder contains the public documentation website for chkit, powered by Astro + Starlight.

Public docs content lives in `src/content/docs/`.

Internal planning/spec documents are intentionally kept in the repository-level `/docs` folder and are not part of this site by default.

## Commands

- `bun run docs:dev` (from repo root): start local docs server at `localhost:4321`
- `bun run docs:build` (from repo root): build production docs site

## Preview feedback

[Agentation](https://agentation.dev) is enabled in the local dev server and PR preview deployments. Open its toolbar in the bottom-right corner to annotate the page and copy feedback.

CI sets `PUBLIC_AGENTATION_ENABLED=true` only for the preview build. To build the same version locally, run `PUBLIC_AGENTATION_ENABLED=true bun run docs:build`. Standard production builds leave the overlay disabled. Turbo includes the flag in the docs build cache key.
