---
title: Getting Started
description: Install chkit and run the first migration flow.
---

## Prerequisites

- Bun `1.3.5+`
- A ClickHouse endpoint

## Install

```bash
bun install
bun run build
bun run chkit --help
```

## Quick Start

```bash
bun run chkit init
bun run chkit generate --name init
bun run chkit migrate
bun run chkit migrate --apply
bun run chkit status
bun run chkit check
```

## Next

- Continue to [CLI Overview](/cli/overview/)
- Continue to [Config Overview](/configuration/overview/)
- Continue to [Schema DSL Reference](/schema/dsl-reference/)
