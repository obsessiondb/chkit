#!/usr/bin/env bash
# Run the main CI checks within the cloud container's resource limits.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

bun run check:workspace-deps
bunx turbo run typecheck lint build --concurrency=1
# CLI tests spawn synchronous subprocesses. Limit concurrent tests as well as
# concurrent packages; retain every test, assertion, and existing timeout.
bunx turbo run test --concurrency=1 -- --max-concurrency=1
bun run check:packed-deps
