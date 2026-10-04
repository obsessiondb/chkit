---
title: "chkit registry"
description: "Browse registry apps, inspect sync resources and integration guides, and build versioned provider templates."
sidebar:
  order: 13
---

Discovers provider templates and builds source catalogs into static, installable JSON artifacts.

## Synopsis

```sh
chkit registry list [flags]
chkit registry inspect <name[@version] | URL | local.json> [flags]
chkit registry build [manifest] [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--registry <location>` | string | `github:obsessiondb/chkit` | Official GitHub registry, catalog URL, local directory, or local catalog file for `list` and name-based `inspect` |
| `--output <directory>` | string | `public/r` | Artifact output directory for `build` |
| `--json` | boolean | `false` | Emit machine-readable results |

The optional build manifest defaults to `registry/registry.json`. These operations do not require a project config or ClickHouse connection. See [CLI Overview](/cli/overview/#global-flags) for global flags.

## Behavior

### List

By default, reads provider directories and manifests from the chkit GitHub repository's `main` branch. It lists their current apps with titles, versions, resource counts, sync strategies, integration guide links, and install commands. The [web integration list](/integrations/) provides logos and dedicated guides for each official app. With a custom registry, a local directory is resolved to its `registry.json`; a URL without a `.json` path is treated as the registry directory.

### Inspect

Loads and validates a built item. In the official GitHub registry, a bare name reads the manifest's current version and then its committed `releases/<version>.json`; a pinned name reads that release directly. With a custom registry, a bare name resolves to `<name>.json` and a pinned name to `<name>/<version>.json` beside the configured catalog. URLs and local JSON paths identify an item directly.

Inspection exposes the version, copied files, optional test set, dependency requirements, environment examples, resource coverage, scopes, and compatibility metadata. Rich provider metadata also includes credential setup steps, destination tables, API references, derived views, schedules, and deletion behavior. When declared, documentation and logo URLs are included. Human output labels environment values as `.env.example` defaults, shows each resource's scopes and strategy, and prints an install command preserving the selected registry. It does not install files or execute the provider.

### Build

Reads the source catalog and each declared source file relative to the manifest directory. Validation covers the supported item format, safe paths, unique targets, required dependencies, and explicit entry exports. The builder embeds source content, computes file hashes, and emits:

- `registry.json`, the current catalog without embedded source content.
- `<name>.json`, the latest built item.
- `<name>/<version>.json`, an immutable built item.

A version file that already exists with different content fails the build. Bump the template version for a changed release and retain all historical version files when publishing. Building into an empty directory cannot detect a version previously published elsewhere.

See [Publish a registry](/api-sync/registry-authoring/) for the source manifest and release workflow.

## Examples

**List official templates:**

```sh
chkit registry list
```

**Inspect a pinned version:**

```sh
chkit registry inspect attio@0.1.2
```

**Build a custom registry:**

```sh
chkit registry build registry/registry.json --output ./registry-output
```

**List a local build as JSON:**

```sh
chkit registry list --registry ./registry-output --json
```

**Inspect an item by URL:**

```sh
chkit registry inspect https://example.com/r/attio/0.1.2.json
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Fetch, parse, validation, source-file, or immutable-version error |

## JSON output

**List:** filter the full resource metadata to show app identity and coverage:

```sh
chkit registry list --json | jq '{command, schemaVersion, ok, action, items: [.items[] | {name, title, version, resourceCount, documentation}]}'
```

```json
{
  "command": "registry",
  "schemaVersion": 1,
  "ok": true,
  "action": "list",
  "items": [
    {
      "name": "attio",
      "title": "Attio",
      "version": "0.1.2",
      "resourceCount": 9,
      "documentation": "https://chkit.obsessiondb.com/integrations/attio/"
    }
  ]
}
```

The `resources` array preserves the manifest's resource descriptions, scopes, strategies, and optional titles, destination tables, and API endpoints. `inspect --json` includes provider authentication, derived views, and sync behavior under `item.meta.chkit` when declared. `documentation` and `logo` are omitted for older or custom items without those optional fields.

**Inspect:** returns `action: "inspect"`, the resolved `origin`, and the full built `item`, including source contents and `meta.chkit`. To extract only the item identity:

```sh
chkit registry inspect attio --json | jq '{command, schemaVersion, ok, action, origin, name: .item.name, version: .item.meta.chkit.version}'
```

```json
{
  "command": "registry",
  "schemaVersion": 1,
  "ok": true,
  "action": "inspect",
  "origin": "https://raw.githubusercontent.com/obsessiondb/chkit/main/registry/attio/releases/0.1.2.json",
  "name": "attio",
  "version": "0.1.2"
}
```

**Build:** file paths are absolute and reflect the selected output directory.

```json
{
  "command": "registry",
  "schemaVersion": 1,
  "ok": true,
  "action": "build",
  "items": ["attio@0.1.2"],
  "files": [
    "/project/registry-output/attio/0.1.2.json",
    "/project/registry-output/attio.json",
    "/project/registry-output/registry.json"
  ]
}
```

**Error:**

```json
{
  "command": "registry",
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "error",
    "message": "Invalid template reference: invalid/name"
  }
}
```

## Related commands

- [Apps & integrations](/integrations/): browse logos, integration guides, and sync coverage.
- [`chkit add`](/cli/add/): install a built template into a project.
- [Provider templates](/api-sync/templates/): source ownership and customization.
- [Publish a registry](/api-sync/registry-authoring/): format and release guidance.
