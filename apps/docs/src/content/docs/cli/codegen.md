---
title: "chkit codegen"
description: "Generate TypeScript types from schema definitions."
sidebar:
  order: 9
---

Shortcut for `chkit plugin codegen codegen`. Generates TypeScript row types, optional Zod schemas, and ingestion functions from your schema definitions.

## Synopsis

```
chkit codegen [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--check` | boolean | `false` | Validate generated artifacts are up-to-date without writing |
| `--out-file <path>` | string | — | Override output file path |
| `--emit-zod` | boolean | — | Enable Zod validator generation |
| `--no-emit-zod` | boolean | — | Disable Zod validator generation |
| `--emit-ingest` | boolean | — | Enable ingestion function generation |
| `--no-emit-ingest` | boolean | — | Disable ingestion function generation |
| `--ingest-out-file <path>` | string | — | Override ingestion output file path |
| `--bigint-mode <mode>` | string | — | Large integer mapping: `string` or `bigint` |
| `--include-views` | boolean | `false` | Include views in generated output |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

This command delegates to the codegen plugin's `codegen` command. The codegen plugin must be registered in your config's `plugins` array with `manifest.name` equal to `"codegen"`.

If the codegen plugin is not configured, the command fails with:
_"Codegen plugin is not configured. Add a plugin with manifest.name "codegen" to config.plugins."_

### Check mode

With `--check`, the command validates that generated artifacts are current without writing files. This is useful in CI to detect stale types. Failure codes include:

- `codegen_missing_output` — types file missing
- `codegen_stale_output` — types content has drifted
- `codegen_missing_ingest_output` — ingest file missing (when `emitIngest` is enabled)
- `codegen_stale_ingest_output` — ingest content has drifted

## Examples

```sh
chkit codegen
```

```sh
chkit codegen --check
```

```sh
chkit codegen --emit-zod --include-views
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (including stale check) |
| 2 | Invalid plugin options |

## Related

- [Codegen plugin reference](/plugins/codegen/) — full documentation for configuration, options, and CI integration
- [`chkit generate`](/cli/generate/) — automatically runs codegen when `runOnGenerate` is enabled
- [`chkit plugin`](/cli/plugin/) — list and run plugin commands directly
