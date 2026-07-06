import { mkdir } from 'node:fs/promises'

import type { ClickHouseExecutor } from '@chkit/clickhouse'
import type { ResolvedChxConfig } from '@chkit/core'

import {
  defineFlags,
  typedFlags,
  type ChxPluginCommand,
  type ChxPluginCommandContext,
  type ParsedFlags,
  type PluginRuntime,
  type TableScope,
} from '../../plugins.js'
import { resolveDirs } from '../../runtime/config.js'
import { debug } from '../../runtime/debug.js'
import { GLOBAL_FLAGS } from '../../runtime/global-flags.js'
import { createJournalStore } from '../../runtime/journal-store.js'
import {
  findChecksumMismatches,
  listMigrations,
  readSnapshot,
  type MigrationJournal,
  type MigrationJournalEntry,
} from '../../runtime/migration-store.js'
import { resolveTableScope, tableKeysFromDefinitions } from '../../runtime/table-scope.js'

import { applyMigration } from './apply.js'
import { scanDestructive } from './destructive.js'
import {
  emitApplySummaryJson,
  emitChecksumMismatchJson,
  emitDestructiveBlockedJson,
  emitNoPending,
  emitNoScopeMatch,
  emitPlanJson,
  renderApplied,
  renderApplySummary,
  renderMigrationLog,
  renderPlanOnlyNotice,
  renderPlanText,
  type MigrateMode,
} from './output.js'
import {
  confirmApply,
  confirmDestructiveExecution,
  isBackgroundOrCI,
  printDestructiveOperationDetails,
} from './prompts.js'
import { filterPendingByScope } from './scope.js'

const MIGRATE_FLAGS = defineFlags([
  { name: '--apply', type: 'boolean', description: 'Apply pending migrations on ClickHouse (no prompt)' },
  { name: '--execute', type: 'boolean', description: 'Alias for --apply' },
  { name: '--allow-destructive', type: 'boolean', description: 'Allow destructive migrations tagged with risk=danger' },
] as const)

export const migrateCommand: ChxPluginCommand = {
  name: 'migrate',
  description: 'Review or execute pending migrations',
  flags: MIGRATE_FLAGS,
  run: cmdMigrate,
}

type JournalStore = ReturnType<typeof createJournalStore>

/** Shared state resolved once by prepareMigration and threaded through the phases. */
interface MigrateContext {
  jsonMode: boolean
  executeRequested: boolean
  allowDestructive: boolean
  mode: MigrateMode
  migrationsDir: string
  db: ClickHouseExecutor
  journalStore: JournalStore
  config: ResolvedChxConfig
  flags: ParsedFlags
  pluginRuntime: PluginRuntime
  tableScope: TableScope
  journal: MigrationJournal
  pendingAll: string[]
}

interface ScopeResolution {
  /** Set when the run terminates during scope resolution; otherwise continue. */
  exit?: number
  pending: string[]
  undeterminedScope: string[]
}

async function cmdMigrate(runCtx: ChxPluginCommandContext): Promise<undefined | number> {
  const ctx = await prepareMigration(runCtx)

  const checksumExit = await runChecksumGate(ctx)
  if (checksumExit !== undefined) return checksumExit

  const scope = await resolvePendingScope(ctx)
  if (scope.exit !== undefined) return scope.exit
  const { pending, undeterminedScope } = scope

  const planExit = await renderPlan(ctx, pending, undeterminedScope)
  if (planExit !== undefined) return planExit

  const confirmExit = await runConfirmGate(ctx)
  if (confirmExit !== undefined) return confirmExit

  const destructiveExit = await runDestructiveGate(ctx, pending)
  if (destructiveExit !== undefined) return destructiveExit

  return applyPending(ctx, pending, undeterminedScope)
}

/** Parse flags, resolve deps, run onConfigLoaded, and load the pending set. */
async function prepareMigration(runCtx: ChxPluginCommandContext): Promise<MigrateContext> {
  const { flags, config, configPath, pluginRuntime, pluginContext } = runCtx
  const f = typedFlags(flags, [...GLOBAL_FLAGS, ...MIGRATE_FLAGS] as const)
  const executeRequested = f['--apply'] === true || f['--execute'] === true
  const allowDestructive = f['--allow-destructive'] === true
  const tableSelector = f['--table']
  const jsonMode = f['--json'] === true

  const { migrationsDir, metaDir } = resolveDirs(config)
  debug('migrate', `flags: execute=${executeRequested}, allowDestructive=${allowDestructive}, json=${jsonMode}`)

  if (!pluginContext.hasExecutor) {
    throw new Error('clickhouse config is required for migrate (journal is stored in ClickHouse)')
  }
  const db = pluginContext.executor
  const journalStore = createJournalStore(db, config.clickhouse?.cluster)
  const snapshot = await readSnapshot(metaDir)
  const tableScope = resolveTableScope(tableSelector, tableKeysFromDefinitions(snapshot?.definitions ?? []))
  const mode: MigrateMode = executeRequested ? 'execute' : 'plan'

  await pluginRuntime.runOnConfigLoaded({
    command: 'migrate',
    config,
    configPath,
    tableScope,
    flags,
  })

  await mkdir(migrationsDir, { recursive: true })
  const files = await listMigrations(migrationsDir)
  const journal = await journalStore.readJournal()
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const pendingAll = files.filter((file) => !appliedNames.has(file))
  debug('migrate', `migrations: total=${files.length}, applied=${journal.applied.length}, pending=${pendingAll.length}`)

  return {
    jsonMode,
    executeRequested,
    allowDestructive,
    mode,
    migrationsDir,
    db,
    journalStore,
    config,
    flags,
    pluginRuntime,
    tableScope,
    journal,
    pendingAll,
  }
}

/** Gate 1: block when applied migrations no longer match their recorded checksum. */
async function runChecksumGate(ctx: MigrateContext): Promise<number | undefined> {
  const { migrationsDir, journal, jsonMode, mode, tableScope } = ctx
  const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)
  if (checksumMismatches.length === 0) return undefined

  debug('migrate', `checksum mismatches: ${checksumMismatches.map((m) => m.name).join(', ')}`)
  if (jsonMode) {
    emitChecksumMismatchJson({ mode, scope: tableScope, checksumMismatches })
    return 1
  }
  throw new Error(
    `Checksum mismatch detected on applied migrations: ${checksumMismatches.map((item) => item.name).join(', ')}`,
  )
}

/** Resolve table scope, filter the pending set, and short-circuit empty runs. */
async function resolvePendingScope(ctx: MigrateContext): Promise<ScopeResolution> {
  const { tableScope, jsonMode, mode, migrationsDir, pendingAll } = ctx

  if (tableScope.enabled && tableScope.matchCount === 0) {
    emitNoScopeMatch({ jsonMode, mode, scope: tableScope })
    return { exit: 0, pending: [], undeterminedScope: [] }
  }

  let pending = pendingAll
  let undeterminedScope: string[] = []
  if (tableScope.enabled) {
    const scoped = await filterPendingByScope(migrationsDir, pendingAll, new Set(tableScope.matchedTables))
    pending = scoped.inScope
    undeterminedScope = scoped.undetermined
  }

  if (pending.length === 0) {
    emitNoPending({ jsonMode, mode, scope: tableScope })
    return { exit: 0, pending, undeterminedScope }
  }

  return { pending, undeterminedScope }
}

/** Render the pending plan (JSON early-return in plan mode, text otherwise). */
async function renderPlan(
  ctx: MigrateContext,
  pending: string[],
  undeterminedScope: string[],
): Promise<number | undefined> {
  const { jsonMode, executeRequested, mode, tableScope, migrationsDir } = ctx

  if (jsonMode && !executeRequested) {
    emitPlanJson({ mode, scope: tableScope, pending, undeterminedScope })
    return 0
  }

  if (!jsonMode) {
    await renderPlanText({ migrationsDir, scope: tableScope, undeterminedScope, pending })
  }

  return undefined
}

/** Gate 2: in plan mode, stop unless the user confirms an interactive apply. */
async function runConfirmGate(ctx: MigrateContext): Promise<number | undefined> {
  const { executeRequested, jsonMode } = ctx
  if (executeRequested) return undefined

  if (isBackgroundOrCI() || jsonMode) {
    if (!jsonMode) renderPlanOnlyNotice()
    return 0
  }

  const confirmed = await confirmApply()
  if (!confirmed) {
    console.log('Migration apply cancelled by user.')
    return 0
  }
  return undefined
}

/** Gate 3: block destructive migrations unless allowed, confirmed, or forced. */
async function runDestructiveGate(ctx: MigrateContext, pending: string[]): Promise<number | undefined> {
  const { migrationsDir, allowDestructive, config, jsonMode, tableScope } = ctx
  const destructive = await scanDestructive(migrationsDir, pending)
  let destructiveAllowed = allowDestructive || config.safety?.allowDestructive === true

  if (destructive.migrations.length > 0 && !destructiveAllowed) {
    const error =
      'Blocked destructive migration execution. Re-run with --allow-destructive or set safety.allowDestructive=true after review.'
    if (jsonMode) {
      emitDestructiveBlockedJson({ scope: tableScope, error, destructive })
      return 3
    }

    if (isBackgroundOrCI()) {
      printDestructiveOperationDetails(destructive.operations)
      throw new Error(
        `${error}\nDestructive migrations: ${destructive.migrations.join(', ')}\n` +
          'Non-interactive run detected. Pass --allow-destructive to proceed.',
      )
    }

    const confirmed = await confirmDestructiveExecution(destructive.operations)
    if (!confirmed) {
      throw new Error(
        `Destructive migration cancelled by user.\nDestructive migrations: ${destructive.migrations.join(', ')}`,
      )
    }
    destructiveAllowed = true
  }

  if (destructive.migrations.length > 0 && !destructiveAllowed) {
    throw new Error('Blocked destructive migration execution.')
  }

  return undefined
}

/** Apply each pending migration, journal it, and emit the final summary. */
async function applyPending(
  ctx: MigrateContext,
  pending: string[],
  undeterminedScope: string[],
): Promise<number> {
  const { jsonMode, migrationsDir, db, journalStore, pluginRuntime, config, tableScope, flags } = ctx

  const appliedNow: MigrationJournalEntry[] = []
  for (const file of pending) {
    if (!jsonMode) await renderMigrationLog(migrationsDir, file)
    const entry = await applyMigration({
      db,
      journalStore,
      pluginRuntime,
      config,
      tableScope,
      flags,
      migrationsDir,
      file,
    })
    appliedNow.push(entry)
    if (!jsonMode) renderApplied(file)
  }

  if (jsonMode) {
    emitApplySummaryJson({ scope: tableScope, applied: appliedNow, undeterminedScope })
    return 0
  }

  renderApplySummary()
  return 0
}
