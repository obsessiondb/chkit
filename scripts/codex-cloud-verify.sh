#!/usr/bin/env bash
# Run the main CI checks within the cloud container's resource limits.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

bun run check:workspace-deps
bunx turbo run typecheck lint build --concurrency=1
# Run all other package tests through Turbo. Run the complete CLI suite separately
# without its parallel workers: Bun 1.3.13 hit epoll/WriteStream errors in cloud.
# Keep its package.json timeout and every test/assertion unchanged.
bunx turbo run test --filter='!chkit' --concurrency=1 -- --max-concurrency=1
(
  cd packages/cli
  bun test src --timeout 15000 --max-concurrency=1
)
bun run check:packed-deps
