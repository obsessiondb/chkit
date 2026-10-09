---
"create-chkit": patch
"@chkit/plugin-obsessiondb": patch
---

Print the "Next steps" block once and with the correct runner for the selected package manager. `create-chkit` previously printed it twice — once package-manager-aware and once from onboarding with a hardcoded `bunx` — so `--package-manager npm` users were told to run `bunx chkit …`. Onboarding now derives the runner (`npx` / `pnpm dlx` / `yarn dlx` / `bunx`) from the package manager, and `create-chkit` only prints its own next-steps when onboarding is skipped, removing the duplicate.
