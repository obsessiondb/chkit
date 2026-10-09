import { defineFlags, typedFlags, type ChxPluginCommand, type ChxPluginCommandContext } from '../../plugins.js'
import { GLOBAL_FLAGS } from '../../runtime/global-flags.js'
import { runSnapshotRebuild } from './rebuild.js'

const SNAPSHOT_FLAGS = defineFlags([
  { name: '--dryrun', type: 'boolean', description: 'Print the rebuild report without writing snapshot.json' },
] as const)

const SNAPSHOT_USAGE = 'Usage: chkit snapshot rebuild [--dryrun] [--json]'

export const snapshotCommand: ChxPluginCommand = {
  name: 'snapshot',
  // Core commands are flattened, so help shows no subcommands; name `rebuild` here.
  description: 'Rebuild snapshot.json from schema definitions (usage: chkit snapshot rebuild [--dryrun])',
  flags: SNAPSHOT_FLAGS,
  run: cmdSnapshot,
}

async function cmdSnapshot(ctx: ChxPluginCommandContext): Promise<number> {
  const f = typedFlags(ctx.flags, [...GLOBAL_FLAGS, ...SNAPSHOT_FLAGS] as const)
  const [subcommand, ...rest] = ctx.args

  if (subcommand === undefined) {
    throw new Error(`Missing snapshot subcommand. Available: rebuild.\n${SNAPSHOT_USAGE}`)
  }
  if (subcommand !== 'rebuild') {
    throw new Error(`Unknown snapshot subcommand "${subcommand}". Available: rebuild.\n${SNAPSHOT_USAGE}`)
  }
  if (rest.length > 0) {
    throw new Error(`Unexpected argument "${rest[0]}" for \`chkit snapshot rebuild\`.\n${SNAPSHOT_USAGE}`)
  }
  if (f['--table'] !== undefined) {
    throw new Error(
      '`chkit snapshot rebuild` always rewrites the whole snapshot and does not support --table. Run it without --table.',
    )
  }

  return runSnapshotRebuild(
    { dryrun: f['--dryrun'] === true, jsonMode: f['--json'] === true },
    { config: ctx.config, configPath: ctx.configPath, flags: ctx.flags, pluginRuntime: ctx.pluginRuntime },
  )
}
