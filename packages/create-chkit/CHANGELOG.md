# create-chkit

## 0.1.2-beta.1

### Patch Changes

- @chkit/plugin-obsessiondb@0.1.2-beta.1

## 0.1.2-beta.0

### Patch Changes

- @chkit/plugin-obsessiondb@0.1.2-beta.0

## 0.1.1

### Patch Changes

- Updated dependencies [c1d8d0d]
  - @chkit/plugin-obsessiondb@0.1.1

## 0.1.0

### Patch Changes

- 4143220: Prompt for the example to scaffold from a bundled manifest instead of silently defaulting to `clickbench`. The list of examples ships with the package and is kept in sync with `examples/` at build time.
- 500b7ba: Add the `create-chkit` package, a scaffolder that downloads a curated example from the chkit repository (default: `clickbench`) into a new project directory, rewrites `chkit` and `@chkit/*` dependency versions to `latest`, and runs install with the detected package manager. Restructure the Getting Started docs into two pages — "Start with an example" (using `create-chkit`) and "Add to an existing project" (using `chkit init`) — and update the docs URL printed by `chkit init` to point to the new page.
- bb62cd0: Print the "Next steps" block once and with the correct runner for the selected package manager. `create-chkit` previously printed it twice — once package-manager-aware and once from onboarding with a hardcoded `bunx` — so `--package-manager npm` users were told to run `bunx chkit …`. Onboarding now derives the runner (`npx` / `pnpm dlx` / `yarn dlx` / `bunx`) from the package manager, and `create-chkit` only prints its own next-steps when onboarding is skipped, removing the duplicate.
- 500b7ba: Fully clear the target directory when the user confirms overwriting a non-empty project directory, so stale files cannot leak into the generated project.
- 99136de: Add ObsessionDB onboarding to `chkit init` and `create-chkit`: a 3-way "how do you want to connect?" prompt covering an existing ClickHouse instance, an existing ObsessionDB account, and claiming a free ObsessionDB dev instance. Adds passwordless CLI signup (`chkit obsessiondb signup`, email + one-time code) with automatic personal-org creation, and `chkit obsessiondb service claim` to claim and provision a free instance, then write a ready-to-use connection.

  Non-interactive callers (agents/CI) now get a full runbook instead of dead-end prompts: when no TTY is detected, onboarding prints every connect path as runnable commands, and `signup` supports a two-step OTP flow — `--request-only` sends the code and prints the exact follow-up command, then `--email --code <CODE>` verifies without re-sending (which would otherwise invalidate the code). When an explicit connect path is requested but cannot complete (e.g. `--connect claim` with no email, or a bad code), `chkit init` and `create-chkit` now exit non-zero instead of falling through to "next steps" with a success status, so scripts can detect the failure.

- Updated dependencies [a94a2a1]
- Updated dependencies [f4ff75d]
- Updated dependencies [bb62cd0]
- Updated dependencies [bb62cd0]
- Updated dependencies [d9d5038]
- Updated dependencies [ca968d9]
- Updated dependencies [f1066a6]
- Updated dependencies [bb62cd0]
- Updated dependencies [0016a11]
- Updated dependencies [bb62cd0]
- Updated dependencies [bb62cd0]
- Updated dependencies [99136de]
- Updated dependencies [c8af201]
- Updated dependencies [0011d85]
- Updated dependencies [75bf348]
- Updated dependencies [a52a2b2]
- Updated dependencies [bb62cd0]
- Updated dependencies [5856d48]
- Updated dependencies [713176e]
- Updated dependencies [45ff0fe]
- Updated dependencies [dfaa8fa]
  - @chkit/plugin-obsessiondb@0.1.0

## 0.1.0-beta.29

### Patch Changes

- 4143220: Prompt for the example to scaffold from a bundled manifest instead of silently defaulting to `clickbench`. The list of examples ships with the package and is kept in sync with `examples/` at build time.
- 500b7ba: Add the `create-chkit` package, a scaffolder that downloads a curated example from the chkit repository (default: `clickbench`) into a new project directory, rewrites `chkit` and `@chkit/*` dependency versions to `latest`, and runs install with the detected package manager. Restructure the Getting Started docs into two pages — "Start with an example" (using `create-chkit`) and "Add to an existing project" (using `chkit init`) — and update the docs URL printed by `chkit init` to point to the new page.
- 500b7ba: Fully clear the target directory when the user confirms overwriting a non-empty project directory, so stale files cannot leak into the generated project.
- 99136de: Add ObsessionDB onboarding to `chkit init` and `create-chkit`: a 3-way "how do you want to connect?" prompt covering an existing ClickHouse instance, an existing ObsessionDB account, and claiming a free ObsessionDB dev instance. Adds passwordless CLI signup (`chkit obsessiondb signup`, email + one-time code) with automatic personal-org creation, and `chkit obsessiondb service claim` to claim and provision a free instance, then write a ready-to-use connection.

  Non-interactive callers (agents/CI) now get a full runbook instead of dead-end prompts: when no TTY is detected, onboarding prints every connect path as runnable commands, and `signup` supports a two-step OTP flow — `--request-only` sends the code and prints the exact follow-up command, then `--email --code <CODE>` verifies without re-sending (which would otherwise invalidate the code). When an explicit connect path is requested but cannot complete (e.g. `--connect claim` with no email, or a bad code), `chkit init` and `create-chkit` now exit non-zero instead of falling through to "next steps" with a success status, so scripts can detect the failure.

- Updated dependencies [a94a2a1]
- Updated dependencies [f4ff75d]
- Updated dependencies [d9d5038]
- Updated dependencies [ca968d9]
- Updated dependencies [f1066a6]
- Updated dependencies [99136de]
- Updated dependencies [c8af201]
- Updated dependencies [0011d85]
- Updated dependencies [75bf348]
- Updated dependencies [a52a2b2]
- Updated dependencies [5856d48]
- Updated dependencies [45ff0fe]
- Updated dependencies [dfaa8fa]
  - @chkit/plugin-obsessiondb@0.1.0-beta.29

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
