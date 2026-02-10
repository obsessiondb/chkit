---
title: Getting Started
description: Install chx and run the first migration flow.
---

## Prerequisites

- Bun `1.3.5+`
- A ClickHouse endpoint

## Install

```bash
bun install
bun run build
bun run chx --help
```

## Quick Start

```bash
bun run chx init
bun run chx generate --name init
bun run chx migrate
bun run chx migrate --apply
bun run chx status
bun run chx check
```

## Next

- Continue to [CLI Overview](/cli/overview/)
- Continue to [Config Overview](/configuration/overview/)
