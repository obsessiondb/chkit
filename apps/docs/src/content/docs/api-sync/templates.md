---
title: Provider templates
description: Copy provider schemas and ingestion readers into a TypeScript project with one command.
---

Provider templates install editable TypeScript source for an API's ClickHouse schema, readers, and ingestion pipeline.

Browse the [app registry and integration list](/integrations/) for available providers, logos, and a dedicated guide to each app's records and sync behavior.

## Install a provider

Run from an existing TypeScript project with `package.json`:

```sh
bunx chkit add attio
```

The installer copies the full provider, wires its exports into the project, and installs the required packages. [Attio](/integrations/attio/) includes object and list metadata, records, list entries, notes, tasks, members, and query views. Each template declares its exact coverage and limitations.

The installed files belong to the project. Edit them, commit them, remove unneeded streams, or adapt their schemas. The registry is used to obtain source code; ingestion reads the installed files.

## Inspect before installing

```sh
bunx chkit registry list
bunx chkit registry inspect attio
bunx chkit add attio --dry-run
```

Inspection shows the template's version, files, dependencies, environment variables, resource coverage, and compatibility requirements. A dry run shows the planned project changes without writing files or installing packages.

Pin an item version for a reproducible installation:

```sh
bunx chkit add attio@0.1.1
```

Template versions are independent of chkit package versions. Their metadata declares the compatible CLI and ingestion package ranges.

## First run

Installation prepares source files and project configuration. Set the provider credentials and the existing project's direct ClickHouse connection, then inspect the graph and generate migrations:

```sh
bunx chkit ingest list
bunx chkit generate --name add-attio
bunx chkit migrate
```

Review the migration SQL before applying it. For the Attio template, run:

```sh
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:attio
```

`add` does not create tables, call the provider API, start ingestion, or configure a scheduler. See [Scheduling and recovery](/api-sync/operations/) when the first run succeeds.

## Existing schema and config

The installer preserves the project's discovery mode. With `entry`, it adds explicit re-exports to that module. With `schema`, it adds the provider entry path alongside the existing schema paths. If no config exists, it creates one pointing to the provider entry. Connection settings and existing plugins stay in place, and the installer registers `ingest()` when needed.

Computed configs, ambiguous exports, and other unsupported shapes produce manual integration guidance before any files are written. Review planned changes with `--dry-run`. Existing schema objects must remain discoverable: omitting them changes the desired schema and can produce drop operations during migration generation.

## Remove unneeded resources

Start by removing the stream from the copied provider's pipeline. Keep the associated schema exports to retain existing tables and views under migration management.

Removing a table or view export changes the desired database schema. Generate and review a migration before removing that schema from the database. Deleting local reader files alone does not delete provider data or stored rows.

## Repeated installs and updates

The installer records the resolved item version and installed file hashes in the project. Reinstalling the same unmodified template is safe. A file changed locally is a conflict; the installer does not overwrite it to match the registry.

There is no automatic update merge or uninstall command. To review a newer template, install it in a separate checkout and compare it with the owned source. Preserve stable stream IDs when adopting changes so checkpoint ownership stays consistent.

## Custom registries

Use a registry catalog, a built item URL, or a local built item:

```sh
bunx chkit registry list --registry https://example.com/r/registry.json
bunx chkit add attio --registry ./my-registry-output
bunx chkit add https://example.com/r/attio/0.1.1.json
bunx chkit add ./my-registry-output/attio/0.1.1.json
```

Treat a third-party template as source code and dependencies to review. chkit supports the documented [registry format](/api-sync/registry-authoring/); a general shadcn UI item is not a chkit provider template.

## Related pages

- [Integrating ClickHouse with Attio](/integrations/attio/): setup, included resources, and sync semantics.
- [`chkit add`](/cli/add/): installation flags and conflict behavior.
- [`chkit registry`](/cli/registry/): discovery, inspection, and builds.
- [Publish a registry](/api-sync/registry-authoring/): author and host templates.
