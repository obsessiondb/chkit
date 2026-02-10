#!/usr/bin/env node
import process from 'node:process'

import { buildApplication, buildCommand, buildRouteMap, run } from '@stricli/core'

import { CLI_VERSION } from './lib.js'
import { cmdCheck } from './commands/check.js'
import { cmdDrift } from './commands/drift.js'
import { cmdGenerate } from './commands/generate.js'
import { cmdInit } from './commands/init.js'
import { cmdMigrate } from './commands/migrate.js'
import { cmdStatus } from './commands/status.js'

function printHelp(): void {
  console.log(`chx - ClickHouse toolkit\n
Usage:
  chx init
  chx generate [--name <migration-name>] [--migration-id <id>] [--config <path>] [--plan] [--json]
  chx migrate [--config <path>] [--execute] [--allow-destructive] [--plan] [--json]
  chx status [--config <path>] [--json]
  chx drift [--config <path>] [--json]
  chx check [--config <path>] [--strict] [--json]

Options:
  --config <path>  Path to config file (default: clickhouse.config.ts)
  --name <name>    Migration name for generate
  --migration-id <id>
                   Deterministic migration file prefix override (e.g. 20260101010101)
  --execute        Execute pending migrations on ClickHouse
  --allow-destructive
                   Required in non-interactive mode when pending migrations contain destructive operations
  --plan           Print plan details for operation review
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
        plan?: boolean
        json?: boolean
      }>({
        parameters: {
          flags: {
            config: optionalStringFlag('Path to config file', 'path'),
            name: optionalStringFlag('Migration name', 'name'),
            migrationId: optionalStringFlag('Deterministic migration file prefix', 'id'),
            plan: optionalBooleanFlag('Print plan details for operation review'),
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
          addBooleanFlag(args, '--plan', flags.plan)
          addBooleanFlag(args, '--json', flags.json)
          await cmdGenerate(args)
          exitIfNeeded()
        },
      }),
      migrate: buildCommand<{
        config?: string
        execute?: boolean
        allowDestructive?: boolean
        plan?: boolean
        json?: boolean
      }>({
        parameters: {
          flags: {
            config: optionalStringFlag('Path to config file', 'path'),
            execute: optionalBooleanFlag('Execute pending migrations on ClickHouse'),
            allowDestructive: optionalBooleanFlag(
              'Allow destructive migrations tagged with risk=danger'
            ),
            plan: optionalBooleanFlag('Print pending migration plan'),
            json: optionalBooleanFlag('Emit machine-readable JSON output'),
          },
        },
        docs: {
          brief: 'Review or execute pending migrations',
        },
        async func(flags) {
          const args: string[] = []
          addStringFlag(args, '--config', flags.config)
          addBooleanFlag(args, '--execute', flags.execute)
          addBooleanFlag(args, '--allow-destructive', flags.allowDestructive)
          addBooleanFlag(args, '--plan', flags.plan)
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

run(app, process.argv.slice(2), { process }).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
