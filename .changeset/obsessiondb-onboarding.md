---
"@chkit/plugin-obsessiondb": minor
"create-chkit": minor
"chkit": minor
---

Add ObsessionDB onboarding to `chkit init` and `create-chkit`: a 3-way "how do you want to connect?" prompt covering an existing ClickHouse instance, an existing ObsessionDB account, and claiming a free ObsessionDB dev instance. Adds passwordless CLI signup (`chkit obsessiondb signup`, email + one-time code) with automatic personal-org creation, and `chkit obsessiondb service claim` to claim and provision a free instance, then write a ready-to-use connection.

Non-interactive callers (agents/CI) now get a full runbook instead of dead-end prompts: when no TTY is detected, onboarding prints every connect path as runnable commands, and `signup` supports a two-step OTP flow — `--request-only` sends the code and prints the exact follow-up command, then `--email --code <CODE>` verifies without re-sending (which would otherwise invalidate the code).
