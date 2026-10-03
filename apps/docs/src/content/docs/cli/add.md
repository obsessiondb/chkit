---
title: "chkit add"
description: "Copy a provider template, register its exports, and install its dependencies."
sidebar:
  order: 12
---

Installs an editable provider template into a TypeScript project, including its schema, ingestion readers, environment examples, and required packages.

## Synopsis

```sh
chkit add <name[@version] | URL | local.json> [flags]
```

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--path <directory>` | string | Template's declared root | Relocate the provider directory inside the current project |
| `--dry-run` | boolean | `false` | Plan changes without writing files or installing packages |
| `--yes`, `-y` | boolean | `false` | Use defaults; accepted for scripted installs without overriding conflicts |
| `--no-install` | boolean | `false` | Write source and dependency declarations without running the package manager |
| `--package-manager <name>` | string | Detected | Use `bun`, `npm`, `pnpm`, or `yarn` |
| `--registry <location>` | string | `https://chkit.obsessiondb.com/r/registry.json` | Catalog URL, local directory, or local catalog file used to resolve template names |
| `--config <path>` | string | `clickhouse.config.ts` | Config file to create or update inside the project |
| `--json` | boolean | `false` | Emit the installation result as JSON |

See [CLI Overview](/cli/overview/#global-flags) for global flags.

## Behavior

### Resolution and compatibility

A name selects the registry's current item; `name@version` selects an immutable template version. An item URL or local JSON path loads a built item directly. Source manifests must first pass through [`chkit registry build`](/cli/registry/).

The installer validates the artifact, file hashes, running CLI version, and declared package ranges before applying changes. Incompatible existing dependencies fail instead of being replaced. The template's ClickHouse range describes its destination requirement; installation does not connect to the database to verify the server version.

### Project changes

The install plan can include:

- Provider files under the declared root or `--path`.
- A new config, or edits that register `ingest()` and include the provider entry in an existing config.
- Explicit provider re-exports when the project already has an `entry` module.
- Required packages in `package.json` and missing example values in `.env.example`.
- Provenance, version, and installed file hashes in `.chkit/registry-lock.json`.

Existing `schema` paths remain in place; the provider entry is added to them. Existing `entry` configs gain named exports while retaining prior schema definitions. Existing connection settings, plugin registrations, and environment examples are preserved.

Computed config shapes, ambiguous exports, package conflicts, and unsupported paths fail before writes and report the required manual integration. Project code is parsed for installation planning rather than imported to discover its shape.

### Package installation

Package-manager selection uses `--package-manager`, then the project's `packageManager` field, then a single recognized lockfile, then CLI environment detection. Multiple package-manager lockfiles require an explicit choice.

By default the selected package manager runs `install` after files are written. `--no-install` still records dependencies in `package.json`. The registry lock tracks whether package installation completed: rerun the same `add` command without `--no-install` to finish a deferred or failed install. Copied files remain after a package-install failure, and the error also reports the direct package-manager command.

### File ownership and conflicts

Source files become project-owned code. Repeating the same template reference at the same version and path leaves identical files unchanged. Locally modified or deleted template files are conflicts, and a reinstall does not overwrite or restore them.

Changing the installed version, origin, or root is not an automatic update operation. Review such changes manually in a separate checkout. Installation uses defaults without an interactive prompt; `--yes` is accepted for scripted workflows and does not override conflicts.

`--path` must be a normalized relative directory inside the project. Absolute targets, path traversal, and symlink destinations are rejected.

### Database and provider access

Installation does not run migrations, query the provider API, start ingestion, or schedule future runs. Configure credentials, inspect `chkit ingest list`, and follow the [template first-run workflow](/api-sync/templates/#first-run).

## Examples

**Install the complete Attio template:**

```sh
chkit add attio
```

**Inspect a pinned installation plan:**

```sh
chkit add attio@0.1.1 --dry-run --json
```

**Choose the provider directory:**

```sh
chkit add attio --path src/providers/attio
```

**Write files for a later dependency install:**

```sh
chkit add attio --yes --no-install --package-manager pnpm
```

**Install a locally built item:**

```sh
chkit add ./registry-output/attio/0.1.1.json --yes
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Successful plan or installation |
| 1 | Resolution, validation, conflict, write, or package-install error |

## JSON output

Results include `command: "add"`, `schemaVersion: 1`, `ok`, and `dryRun`. The plan reports `template` (`name`, `version`, `origin`), `files`, missing `dependencies`, selected `packageManager`, `noInstall`, `alreadyInstalled`, and `installRequired`. The last field describes whether dependency installation was required when the plan was created.

Each planned file has a project-relative `path`, an `action` of `create` or `update`, and its complete planned `content`. Dry-run output therefore includes local configuration source that the installer plans to change.

**Unchanged repeated installation:**

```json
{
  "command": "add",
  "schemaVersion": 1,
  "ok": true,
  "dryRun": false,
  "template": {
    "name": "attio",
    "version": "0.1.1",
    "origin": "https://chkit.obsessiondb.com/r/attio.json"
  },
  "files": [],
  "dependencies": [],
  "packageManager": "bun",
  "noInstall": false,
  "alreadyInstalled": true,
  "installRequired": false
}
```

The same command with `--dry-run` returns `dryRun: true`. A first install reports the files it would create or update instead of the empty array. Applied results also include planned file contents; `dryRun` distinguishes planning from writing.

**Error:**

```json
{
  "command": "add",
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "error",
    "message": "Local template file was modified: src/integrations/attio/config.ts. It will not be restored or overwritten."
  }
}
```

## Related commands

- [Apps & integrations](/integrations/): browse apps and their complete sync guides.
- [`chkit registry`](/cli/registry/): discover, inspect, and build templates.
- [`chkit ingest`](/cli/ingest/): inspect and run the installed pipeline.
- [`chkit generate`](/cli/generate/): generate destination migrations.
- [`chkit migrate`](/cli/migrate/): review and apply the destination schema.
