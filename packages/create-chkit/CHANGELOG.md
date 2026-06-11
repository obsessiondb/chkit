# create-chkit

## 0.1.0-beta.27

### Patch Changes

- 4143220: Prompt for the example to scaffold from a bundled manifest instead of silently defaulting to `clickbench`. The list of examples ships with the package and is kept in sync with `examples/` at build time.
- 500b7ba: Add the `create-chkit` package, a scaffolder that downloads a curated example from the chkit repository (default: `clickbench`) into a new project directory, rewrites `chkit` and `@chkit/*` dependency versions to `latest`, and runs install with the detected package manager. Restructure the Getting Started docs into two pages — "Start with an example" (using `create-chkit`) and "Add to an existing project" (using `chkit init`) — and update the docs URL printed by `chkit init` to point to the new page.
- 500b7ba: Fully clear the target directory when the user confirms overwriting a non-empty project directory, so stale files cannot leak into the generated project.

## 0.1.0-beta.26

### Patch Changes

- 4143220: Prompt for the example to scaffold from a bundled manifest instead of silently defaulting to `clickbench`. The list of examples ships with the package and is kept in sync with `examples/` at build time.
- 500b7ba: Add the `create-chkit` package, a scaffolder that downloads a curated example from the chkit repository (default: `clickbench`) into a new project directory, rewrites `chkit` and `@chkit/*` dependency versions to `latest`, and runs install with the detected package manager. Restructure the Getting Started docs into two pages — "Start with an example" (using `create-chkit`) and "Add to an existing project" (using `chkit init`) — and update the docs URL printed by `chkit init` to point to the new page.
- 500b7ba: Fully clear the target directory when the user confirms overwriting a non-empty project directory, so stale files cannot leak into the generated project.

## 0.1.0-beta.25

### Patch Changes

- 500b7ba: Add the `create-chkit` package, a scaffolder that downloads a curated example from the chkit repository (default: `clickbench`) into a new project directory, rewrites `chkit` and `@chkit/*` dependency versions to `latest`, and runs install with the detected package manager. Restructure the Getting Started docs into two pages — "Start with an example" (using `create-chkit`) and "Add to an existing project" (using `chkit init`) — and update the docs URL printed by `chkit init` to point to the new page.
- 500b7ba: Fully clear the target directory when the user confirms overwriting a non-empty project directory, so stale files cannot leak into the generated project.
