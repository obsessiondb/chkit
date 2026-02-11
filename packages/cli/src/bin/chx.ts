#!/usr/bin/env node
import process from 'node:process'

import { buildApplication, buildCommand, buildRouteMap, run } from '@stricli/core'

import { CLI_VERSION } from './lib.js'
import { cmdCheck } from './commands/check.js'
import { cmdDrift } from './commands/drift.js'
import { cmdGenerate } from './commands/generate.js'
import { cmdInit } from './commands/init.js'
import { cmdMigrate } from './commands/migrate.js'
import { cmdPlugin } from './commands/plugin.js'
import { cmdStatus } from './commands/status.js'
import { cmdTypegen } from './commands/typegen.js'

function printHelp(): void {
  console.log(`chx - ClickHouse toolkit\n
Usage:
  chx init
  chx generate [--name <migration-name>] [--migration-id <id>] [--rename-table <old_db.old_table=new_db.new_table>] [--rename-column <db.table.old_column=new_column>] [--config <path>] [--dryrun] [--json]
  chx typegen [--check] [--out-file <path>] [--emit-zod] [--no-emit-zod] [--bigint-mode <string|bigint>] [--include-views] [--config <path>] [--json]
  chx migrate [--config <path>] [--apply|--execute] [--allow-destructive] [--json]
  chx status [--config <path>] [--json]
  chx drift [--config <path>] [--json]
  chx check [--config <path>] [--strict] [--json]
  chx plugin [<plugin-name> [<command> ...]] [--config <path>] [--json]

Options:
  --config <path>  Path to config file (default: clickhouse.config.ts)
  --name <name>    Migration name for generate
  --migration-id <id>
                   Deterministic migration file prefix override (e.g. 20260101010101)
  --rename-table <old_db.old_table=new_db.new_table>
                   Explicit table rename mapping (comma-separated values supported)
  --rename-column <db.table.old_column=new_column>
                   Explicit column rename mapping (comma-separated values supported)
  --apply          Apply pending migrations on ClickHouse (no prompt)
  --execute        Alias for --apply
  --allow-destructive
                   Required in non-interactive mode when pending migrations contain destructive operations
  --dryrun         Print operation plan without writing artifacts
  --check          Validate generated type artifacts are up-to-date
  --out-file <path>
                   Override typegen output file path for one run
  --emit-zod       Enable Zod validator generation in typegen
  --no-emit-zod    Disable Zod validator generation in typegen
  --bigint-mode <mode>
                   Set large integer mapping mode for typegen (string|bigint)
  --include-views  Include views in typegen output
  --strict         Force all check policies on for this invocation
  --json           Emit machine-readable JSON output
  -h, --help       Show help
  -v, --version    Show version
`)
}

function addStringFlag(args: string[], flag: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return
  args.push(flag, value)
}

function addBooleanFlag(args: string[], flag: string, enabled: boolean | undefined): void {
  if (enabled) args.push(flag)
}

function exitIfNeeded(): void {
  const code =
    typeof process.exitCode === 'number'
      ? process.exitCode
      : process.exitCode
        ? Number(process.exitCode)
        : 0
  if (Number.isFinite(code) && code > 0) {
    process.exit(code)
  }
}

const optionalStringFlag = (brief: string, placeholder = 'value') => ({
  kind: 'parsed' as const,
  brief,
  parse: (input: string): string => input,
  optional: true as const,
  placeholder,
})

const optionalBooleanFlag = (brief: string) => ({
  kind: 'boolean' as const,
  brief,
  optional: true as const,
})

const app = buildApplication(
  buildRouteMap({
    docs: {
      brief: 'ClickHouse schema and migration toolkit',
    },
    routes: {
      init: buildCommand({
        parameters: {},
        docs: {
          brief: 'Initialize config and schema starter files',
        },
        async func() {
          await cmdInit()
        },
      }),
      generate: buildCommand<{
        config?: string
        name?: string
        migrationId?: string
        renameTable?: string
        renameColumn?: string
        dryrun?: boolean
        json?: boolean
      }>({
        parameters: {
          flags: {
            config: optionalStringFlag('Path to config file', 'path'),
            name: optionalStringFlag('Migration name', 'name'),
            migrationId: optionalStringFlag('Deterministic migration file prefix', 'id'),
            renameTable: optionalStringFlag(
              'Explicit table rename mapping old_db.old_table=new_db.new_table'
            ),
            renameColumn: optionalStringFlag(
              'Explicit column rename mapping db.table.old_column=new_column'
            ),
            dryrun: optionalBooleanFlag('Print operation plan without writing artifacts'),
            json: optionalBooleanFlag('Emit machine-readable JSON output'),
          },
        },
        docs: {
          brief: 'Generate migration artifacts from schema definitions',
        },
        async func(flags) {
          const args: string[] = []
          addStringFlag(args, '--config', flags.config)
          addStringFlag(args, '--name', flags.name)
          addStringFlag(args, '--migration-id', flags.migrationId)
          addStringFlag(args, '--rename-table', flags.renameTable)
          addStringFlag(args, '--rename-column', flags.renameColumn)
          addBooleanFlag(args, '--dryrun', flags.dryrun)
          addBooleanFlag(args, '--json', flags.json)
          await cmdGenerate(args)
          exitIfNeeded()
        },
      }),
      typegen: buildCommand<{
        config?: string
        check?: boolean
        outFile?: string
        emitZod?: boolean
        noEmitZod?: boolean
        bigintMode?: string
        includeViews?: boolean
        json?: boolean
      }>({
        parameters: {
          flags: {
            config: optionalStringFlag('Path to config file', 'path'),
            check: optionalBooleanFlag('Check for stale generated artifacts without writing'),
            outFile: optionalStringFlag('Output file path override', 'path'),
            emitZod: optionalBooleanFlag('Emit Zod validators'),
            noEmitZod: optionalBooleanFlag('Disable Zod validator emission'),
            bigintMode: optionalStringFlag('Bigint type mode: string or bigint', 'mode'),
            includeViews: optionalBooleanFlag('Include views in generated types'),
            json: optionalBooleanFlag('Emit machine-readable JSON output'),
          },
        },
        docs: {
          brief: 'Run type generation plugin workflow',
        },
        async func(flags) {
          const args: string[] = []
          addStringFlag(args, '--config', flags.config)
          addBooleanFlag(args, '--check', flags.check)
          addStringFlag(args, '--out-file', flags.outFile)
          addBooleanFlag(args, '--emit-zod', flags.emitZod)
          addBooleanFlag(args, '--no-emit-zod', flags.noEmitZod)
          addStringFlag(args, '--bigint-mode', flags.bigintMode)
          addBooleanFlag(args, '--include-views', flags.includeViews)
          addBooleanFlag(args, '--json', flags.json)
          await cmdTypegen(args)
          exitIfNeeded()
        },
      }),
      migrate: buildCommand<{
        config?: string
        apply?: boolean
        execute?: boolean
        allowDestructive?: boolean
        json?: boolean
      }>({
        parameters: {
          flags: {
            config: optionalStringFlag('Path to config file', 'path'),
            apply: optionalBooleanFlag('Apply pending migrations on ClickHouse'),
            execute: optionalBooleanFlag('Execute pending migrations on ClickHouse'),
            allowDestructive: optionalBooleanFlag(
              'Allow destructive migrations tagged with risk=danger'
            ),
            json: optionalBooleanFlag('Emit machine-readable JSON output'),
          },
        },
        docs: {
          brief: 'Review or execute pending migrations',
        },
        async func(flags) {
          const args: string[] = []
          addStringFlag(args, '--config', flags.config)
          addBooleanFlag(args, '--apply', flags.apply)
          addBooleanFlag(args, '--execute', flags.execute)
          addBooleanFlag(args, '--allow-destructive', flags.allowDestructive)
          addBooleanFlag(args, '--json', flags.json)
          await cmdMigrate(args)
          exitIfNeeded()
        },
      }),
      status: buildCommand<{ config?: string; json?: boolean }>({
        parameters: {
          flags: {
            config: optionalStringFlag('Path to config file', 'path'),
            json: optionalBooleanFlag('Emit machine-readable JSON output'),
          },
        },
        docs: {
          brief: 'Show migration status and checksum mismatch information',
        },
        async func(flags) {
          const args: string[] = []
          addStringFlag(args, '--config', flags.config)
          addBooleanFlag(args, '--json', flags.json)
          await cmdStatus(args)
          exitIfNeeded()
        },
      }),
      drift: buildCommand<{ config?: string; json?: boolean }>({
        parameters: {
          flags: {
            config: optionalStringFlag('Path to config file', 'path'),
            json: optionalBooleanFlag('Emit machine-readable JSON output'),
          },
        },
        docs: {
          brief: 'Compare snapshot state with current ClickHouse objects',
        },
        async func(flags) {
          const args: string[] = []
          addStringFlag(args, '--config', flags.config)
          addBooleanFlag(args, '--json', flags.json)
          await cmdDrift(args)
          exitIfNeeded()
        },
      }),
      check: buildCommand<{ config?: string; strict?: boolean; json?: boolean }>({
        parameters: {
          flags: {
            config: optionalStringFlag('Path to config file', 'path'),
            strict: optionalBooleanFlag('Enable all policy checks'),
            json: optionalBooleanFlag('Emit machine-readable JSON output'),
          },
        },
        docs: {
          brief: 'Run policy checks for CI and release gates',
        },
        async func(flags) {
          const args: string[] = []
          addStringFlag(args, '--config', flags.config)
          addBooleanFlag(args, '--strict', flags.strict)
          addBooleanFlag(args, '--json', flags.json)
          await cmdCheck(args)
          exitIfNeeded()
        },
      }),
      plugin: buildCommand<{
        config?: string
        json?: boolean
      }>({
        parameters: {
          flags: {
            config: optionalStringFlag('Path to config file', 'path'),
            json: optionalBooleanFlag('Emit machine-readable JSON output'),
          },
        },
        docs: {
          brief: 'List plugins and run plugin namespace commands',
        },
        async func(flags) {
          const args: string[] = []
          addStringFlag(args, '--config', flags.config)
          addBooleanFlag(args, '--json', flags.json)
          await cmdPlugin(args)
          exitIfNeeded()
        },
      }),
      help: buildCommand({
        parameters: {},
        docs: {
          brief: 'Print help information',
        },
        func() {
          printHelp()
        },
      }),
      version: buildCommand({
        parameters: {},
        docs: {
          brief: 'Print version information',
        },
        func() {
          console.log(CLI_VERSION)
        },
      }),
    },
  }),
  {
    name: 'chx',
    versionInfo: { currentVersion: CLI_VERSION },
    scanner: { caseStyle: 'allow-kebab-for-camel' },
  }
)

const argv = process.argv.slice(2)
if (argv[0] === 'plugin') {
  cmdPlugin(argv.slice(1))
    .then(() => {
      exitIfNeeded()
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
} else if (argv[0] === 'typegen') {
  cmdTypegen(argv.slice(1))
    .then(() => {
      exitIfNeeded()
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
} else {
  run(app, argv, { process }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
