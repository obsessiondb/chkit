import { mkdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'

import { assertServerIndexGranularity, type ClickHouseExecutor, type ClickHouseSettings } from '@chkit/clickhouse'
import { configuredIndexGranularity, type ResolvedChxConfig } from '@chkit/core'

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
import { GLOBAL_FLAGS, TABLE_FLAG } from '../../runtime/global-flags.js'
import { createJournalStore, type MigrationRowState } from '../../runtime/journal-store.js'
import {
  findChecksumMismatches,
  listMigrations,
  readSnapshot,
  type MigrationJournal,
  type MigrationJournalEntry,
} from '../../runtime/migration-store.js'
import { resolveTableScope, tableKeysFromDefinitions } from '../../runtime/table-scope.js'

import { abandonMigrationState, abandonReport, readAbandonableState } from './abandon.js'
import { applyMigration } from './apply.js'
import { findPendingNonSelectBarriers } from './barrier.js'
import { scanDestructive } from './destructive.js'
import { findEmptyMigrations } from './empty.js'
import { emptyMigrationsError, journalChangedError, MigrateError, nonSelectBarrierError } from './errors.js'
import { acquireMigrateLock, guardExecutor, migrateLockDisabled, type MigrateLock } from './lock.js'
import {
  emitAbandonJson,
  emitApplySummaryJson,
  emitChecksumMismatchJson,
  emitDestructiveBlockedJson,
  emitEmptyMigrationsBlockedJson,
  emitNoPending,
  emitNoScopeMatch,
  emitPlanJson,
  renderAbandonPlanOnlyNotice,
  renderAbandonText,
  renderApplied,
  renderApplySummary,
  renderMigrationLog,
  renderPlanOnlyNotice,
  renderPlanText,
  type MigrateMode,
} from './output.js'
import {
  confirmAbandon,
  confirmApply,
  confirmDestructiveExecution,
  isBackgroundOrCI,
  printDestructiveOperationDetails,
} from './prompts.js'
import { resolveRecoveryTargets } from './recovery.js'
import { resolveRetry, type RetryResolution } from './retry.js'
import { filterPendingByScope } from './scope.js'
import { parseSettingFlags } from './settings.js'
import { extractExecutableStatements, extractMigrationOperationSummaries } from '../../runtime/safety-markers.js'
import { createQueryTracker, queryTrackingDisabled, type QueryContext, type QueryIdentity, type QueryTracker } from './query-intents.js'
import { assertCancellationClear, assertCancellationUnfinished, cancelPredecessor, freshRecoveryExecutor, finishRecovery, expandRecoveryPlan, markCancellationPending, settleCompensation, prepareCancellation, resolveQueryIdentity } from './cancellation.js'

const MIGRATE_FLAGS = defineFlags([
  TABLE_FLAG,
  { name: '--apply', type: 'boolean', description: 'Apply pending migrations on ClickHouse (no prompt)' },
  { name: '--execute', type: 'boolean', description: 'Alias for --apply' },
  { name: '--allow-destructive', type: 'boolean', description: 'Allow destructive migrations tagged with risk=danger' },
  {
    name: '--retry',
    type: 'string',
    description: 'Resume a failed migration after editing its file (skips completed statements)',
    placeholder: '<migration>',
  },
  {
    name: '--abandon',
    type: 'string',
    description: 'Reset a failed migration so the next apply runs it from statement 1 (journal only; previews without --apply)',
    placeholder: '<migration>',
  },
  {
    name: '--break-lock',
    type: 'string',
    description: 'Release the migrate lock claim of a run that is no longer running, then take the lock',
    placeholder: '<claim>',
  },
  {
    name: '--setting',
    type: 'string[]',
    description: 'ClickHouse query setting sent with each migration statement, e.g. max_table_size_to_drop=0 (repeatable)',
    placeholder: '<name=value>',
  },
  { name: '--cancel-lock-queries', type: 'boolean', description: 'Cancel the tracked queries of the stopped --break-lock run before recovery (requires --apply)' },
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
  /** --setting values, sent with every migration statement. */
  settings: ClickHouseSettings | undefined
  mode: MigrateMode
  migrationsDir: string
  metaDir: string
  db: ClickHouseExecutor
  journalStore: JournalStore
  config: ResolvedChxConfig
  flags: ParsedFlags
  pluginRuntime: PluginRuntime
  tableScope: TableScope
  journal: MigrationJournal
  files: string[]
  appliedNames: ReadonlySet<string>
  pendingAll: string[]
  retryTarget: string | undefined
  abandonTarget: string | undefined
  /** Runs `fn` holding the migrate lock (#716). */
  withLock: WithLock
  queryTracker: () => QueryTracker | undefined
  completeRecovery?: () => Promise<void>
}

type WithLock = <T>(fn: () => Promise<T>, selectedFiles?: readonly string[]) => Promise<T>

interface ScopeResolution {
  /** --table matched no table, so no migration is selected. */
  noScopeMatch: boolean
  pending: string[]
  undeterminedScope: string[]
}

/** What this run would apply, resolved before any gate. */
interface PendingPlan extends ScopeResolution {
  emptyMigrations: string[]
  retry: RetryResolution | undefined
}

/** The parts of the migrate context that --abandon reads. */
type AbandonContext = Pick<
  MigrateContext,
  'jsonMode' | 'executeRequested' | 'journalStore' | 'tableScope' | 'appliedNames' | 'files' | 'metaDir'
> & { withLock?: WithLock }

/** How --abandon asks before it changes the journal without --apply. */
interface AbandonPrompt {
  /** Whether someone can answer a prompt: a TTY outside CI. */
  isInteractive: () => boolean
  confirm: (migration: string) => Promise<boolean>
}

const TERMINAL_PROMPT: AbandonPrompt = {
  isInteractive: () => !isBackgroundOrCI(),
  confirm: confirmAbandon,
}

async function cmdMigrate(runCtx: ChxPluginCommandContext): Promise<undefined | number> {
  const ctx = await prepareMigration(runCtx)
  if (ctx.abandonTarget !== undefined) return runAbandon(ctx, ctx.abandonTarget)
  // A migration generated for another index_granularity default would create
  // tables unlike the ones chkit planned for (#466).
  await assertServerIndexGranularity(ctx.db, configuredIndexGranularity(ctx.config))

  const checksumExit = await runChecksumGate(ctx)
  if (checksumExit !== undefined) return checksumExit

  const plan = await resolvePendingPlan(ctx)
  if (plan.pending.length === 0) return ctx.executeRequested ? ctx.withLock(async () => renderNothingPending(ctx, plan)) : renderNothingPending(ctx, plan)

  const planExit = await renderPlan(ctx, plan)
  if (planExit !== undefined) return planExit

  const emptyExit = runEmptyMigrationGate(ctx, plan.emptyMigrations)
  if (emptyExit !== undefined) return emptyExit

  await runBarrierGate(ctx, plan.pending)

  const confirmExit = await runConfirmGate(ctx)
  if (confirmExit !== undefined) return confirmExit

  const destructiveExit = await runDestructiveGate(ctx, plan.pending)
  if (destructiveExit !== undefined) return destructiveExit

  return applyPending(ctx, plan)
}

/** Parse flags, resolve deps, run onConfigLoaded, and load the pending set. */
async function prepareMigration(runCtx: ChxPluginCommandContext): Promise<MigrateContext> {
  const { flags, config, configPath, pluginRuntime, pluginContext } = runCtx
  const f = typedFlags(flags, [...GLOBAL_FLAGS, ...MIGRATE_FLAGS] as const)
  const executeRequested = f['--apply'] === true || f['--execute'] === true
  const allowDestructive = f['--allow-destructive'] === true
  const settings = parseSettingFlags(f['--setting'])
  const tableSelector = f['--table']
  const jsonMode = f['--json'] === true
  const { retryTarget, abandonTarget } = resolveRecoveryTargets(flags)
  const cancelQueries = f['--cancel-lock-queries'] === true
  if (cancelQueries && (f['--apply'] !== true || !f['--break-lock'] || abandonTarget !== undefined || migrateLockDisabled() || queryTrackingDisabled())) {
    throw new MigrateError('invalid_usage', '--cancel-lock-queries requires explicit --apply, --break-lock <claim>, an enabled migrate lock and query tracking, and no --abandon.')
  }

  const { migrationsDir, metaDir } = resolveDirs(config)
  debug(
    'migrate',
    `flags: execute=${executeRequested}, allowDestructive=${allowDestructive}, json=${jsonMode}, ` +
      `retry=${retryTarget ?? '-'}, abandon=${abandonTarget ?? '-'}`,
  )

  if (!pluginContext.hasExecutor) {
    throw new Error('clickhouse config is required for migrate (journal is stored in ClickHouse)')
  }
  // Every request of the run, journal writes included, first checks that
  // the run still holds the migrate lock, once it took it (#716).
  let heldLock: MigrateLock | undefined
  let queryTracker: QueryTracker | undefined
  let completeRecovery: (() => Promise<void>) | undefined
  const rawDb = cancelQueries ? freshRecoveryExecutor(pluginContext.executor) : pluginContext.executor
  const initialIdentity = cancelQueries ? await resolveQueryIdentity(rawDb, config.clickhouse?.cluster) : undefined
  const recoveryCluster = initialIdentity?.cluster
  if (initialIdentity && !recoveryCluster) throw new MigrateError('migrate_cancellation_failed', 'Explicit recovery requires an attested cluster.')
  const db = guardExecutor(rawDb, () => heldLock?.assertHeld())
  const journalStore = createJournalStore(db, config.clickhouse?.cluster, initialIdentity && recoveryCluster
    ? { cluster: recoveryCluster, replicas: initialIdentity.serverUUIDs.length } : undefined)
  const breakLock = f['--break-lock']
  // Progress lines go to stderr in --json mode, so stdout stays one JSON document.
  const log = jsonMode ? (line: string) => console.error(line) : (line: string) => console.log(line)
  const withLock: WithLock = async (fn, selectedFiles = []) => {
    if (migrateLockDisabled()) {
      console.error('⚠ CHKIT_MIGRATE_LOCK is off: this run takes no migrate lock, so a concurrent migrate can apply the same statements.')
      return await fn()
    }
    const target = await journalStore.lockTarget()
    if (target === null) {
      if (cancelQueries) throw new MigrateError('migrate_cancellation_failed', 'The database/journal does not exist; cancellation cannot be verified.')
      console.error(
        '⚠ The target database does not exist yet, so the journal cannot hold the migrate lock: this run takes none. ' +
          'Do not start another migrate against this target until it finishes.',
      )
      return await fn()
    }
    const heartbeatDb = rawDb.openConcurrent?.()
    try {
      let identity: QueryIdentity | undefined = initialIdentity
      if (!identity && !queryTrackingDisabled() && rawDb.commandTracked && rawDb.queryControl) {
        try { identity = await resolveQueryIdentity(rawDb, config.clickhouse?.cluster) }
        catch (error) {
          if (cancelQueries) throw error
          debug('migrate:queries', `query tracking unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (cancelQueries && !identity) throw new MigrateError('migrate_cancellation_failed', 'This executor cannot safely track/cancel queries.')
      let cancellation = cancelQueries && identity && breakLock ? await prepareCancellation(rawDb, target, identity, breakLock) : undefined
      if (cancellation) {
        const contexts: QueryContext[] = []
        for (const file of selectedFiles) {
          const state = await journalStore.readMigrationState(file)
          if (state?.operations.some((op) => op.status !== 'completed' && op.queryId !== '')) throw new MigrateError('migrate_cancellation_failed', `Explicit recovery cannot attach the historical async attempt in ${file}. Finish async recovery before using --cancel-lock-queries.`)
          const sql = await readFile(join(migrationsDir, file), 'utf8')
          const summaries = extractMigrationOperationSummaries(sql)
          for (const [statementIndex, forwardSQL] of extractExecutableStatements(sql).entries()) {
            const operation = summaries[statementIndex]
            if (operation && operation.mode !== 'sync') throw new MigrateError('migrate_cancellation_failed', 'Explicit recovery requires a fully synchronous selected migration plan.')
            contexts.push({ migration: file, statementIndex, forwardSQL, beforeRetry: operation?.beforeRetry ?? null })
          }
        }
        cancellation = await expandRecoveryPlan(rawDb, target, cancellation, contexts)
      }
      await assertCancellationClear(rawDb, target, cancellation?.claim, identity)
      const migrationHooks = pluginRuntime.plugins.some((item) => item.plugin.hooks?.onBeforeApply || item.plugin.hooks?.onAfterApply)
      if (cancelQueries && migrationHooks) throw new MigrateError('migrate_cancellation_failed', 'Cancellation cannot cover arbitrary migration plugin hooks.')
      const trackedIdentity = migrationHooks ? undefined : identity
      const lock = await acquireMigrateLock(rawDb, target, {
        breakLock: cancellation?.claim ?? breakLock, log, heartbeatDb, queryTracking: trackedIdentity,
        ...(cancellation ? { takeover: { claim: cancellation.claim, holder: cancellation.holder, beforeRelease: () => markCancellationPending(rawDb, target, cancellation),
          resumePending: (reservations) => assertCancellationUnfinished(rawDb, target, cancellation, reservations),
        } } : {}),
      })
      heldLock = lock
      try {
        await assertCancellationClear(rawDb, target, cancellation?.claim, identity)
        const recovery = cancellation ? await cancelPredecessor(rawDb, target, cancellation, lock) : undefined
        completeRecovery = recovery ? async () => { await finishRecovery(rawDb, target, recovery, lock); completeRecovery = undefined } : undefined
        queryTracker = trackedIdentity ? createQueryTracker({ db: rawDb, target, identity: trackedIdentity, lock, ...(cancellation && recovery ? { recovery: { targets: recovery.obligations.map((item) => item.target), sources: recovery.obligations.flatMap((item) => item.source ? [item.source] : []), obligations: recovery.obligations, afterCompensation: (table) => settleCompensation(rawDb, target, cancellation, table, lock) } } : {}), log }) : undefined
        const result = await fn()
        await completeRecovery?.()
        return result
      } catch (error) {
        // A step that retries or wraps the guard's error (a poll loop, a
        // statement error) reports the lost lock, with its code (#716).
        lock.assertHeld()
        throw error
      } finally {
        heldLock = undefined
        queryTracker = undefined
        completeRecovery = undefined
        await lock.release()
      }
    } finally {
      await heartbeatDb?.close()
    }
  }
  // --abandon only changes the journal and rejects --table, so it does not
  // read snapshot.json: a conflicted snapshot cannot block it.
  const snapshot = abandonTarget === undefined
    ? await readSnapshot(metaDir, { indexGranularity: configuredIndexGranularity(config) })
    : null
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
  if (retryTarget !== undefined && !files.includes(retryTarget)) {
    throw new MigrateError(
      'migration_not_found',
      `--retry: no migration file named ${retryTarget} in ${migrationsDir}. To reset the journal state of a migration whose file was deleted, use chkit migrate --abandon ${retryTarget}.`,
    )
  }
  const journal = await journalStore.readJournal()
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const pendingAll = files.filter((file) => !appliedNames.has(file))
  debug('migrate', `migrations: total=${files.length}, applied=${journal.applied.length}, pending=${pendingAll.length}`)

  return {
    jsonMode,
    executeRequested,
    allowDestructive,
    settings,
    mode,
    migrationsDir,
    metaDir,
    db,
    journalStore,
    config,
    flags,
    pluginRuntime,
    tableScope,
    journal,
    files,
    appliedNames,
    pendingAll,
    retryTarget,
    abandonTarget,
    withLock,
    queryTracker: () => queryTracker,
    completeRecovery: async () => { await completeRecovery?.() },
  }
}

/**
 * --abandon <migration>: reset the journal state of a failed migration so the
 * next apply runs it from statement 1. Without --apply it only previews, like
 * the rest of migrate, or asks first in an interactive terminal. Runs before
 * every other gate and applies nothing.
 */
export async function runAbandon(
  ctx: AbandonContext,
  migration: string,
  prompt: AbandonPrompt = TERMINAL_PROMPT,
): Promise<number> {
  const { jsonMode, executeRequested, journalStore, tableScope } = ctx
  const state = await readAbandonableState({ migration, appliedNames: ctx.appliedNames }, { journalStore })
  const report = abandonReport(state)
  const textInput = {
    fileExists: ctx.files.includes(migration),
    snapshotFile: relative(process.cwd(), join(ctx.metaDir, 'snapshot.json')),
  }

  if (!executeRequested) {
    if (jsonMode) {
      emitAbandonJson({ mode: 'plan', scope: tableScope, abandon: report })
      return 0
    }
    renderAbandonText(report, { ...textInput, performed: false })
    if (!prompt.isInteractive()) {
      renderAbandonPlanOnlyNotice()
      return 0
    }
    if (!(await prompt.confirm(migration))) {
      console.log('Abandon cancelled by user.')
      return 0
    }
    await abandonUnderLock(ctx, migration, state)
    console.log(`Abandoned in-progress migration ${migration}.`)
    return 0
  }

  await abandonUnderLock(ctx, migration, state)
  if (jsonMode) {
    emitAbandonJson({ mode: 'execute', scope: tableScope, abandon: report })
    return 0
  }
  renderAbandonText(report, { ...textInput, performed: true })
  return 0
}

/**
 * Resets the state the user saw, holding the migrate lock, so --abandon
 * never rewrites a migration that a running apply is recording (#716).
 */
async function abandonUnderLock(ctx: AbandonContext, migration: string, state: MigrationRowState): Promise<void> {
  const { journalStore, appliedNames } = ctx
  const withLock = ctx.withLock ?? ((fn) => fn())
  await withLock(async () => {
    const current = await readAbandonableState({ migration, appliedNames }, { journalStore })
    if (current.appliedAt !== state.appliedAt) {
      throw journalChangedError(`the journal state of ${migration} is no longer the one shown`)
    }
    await abandonMigrationState(current, { journalStore })
  })
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

/**
 * Filter the pending set by table scope, find the files without statements,
 * and resolve --retry, before any gate runs. --retry is resolved even when
 * nothing is pending, so every run reports what it did.
 */
async function resolvePendingPlan(ctx: MigrateContext): Promise<PendingPlan> {
  const { migrationsDir, retryTarget, journalStore, appliedNames, pluginRuntime } = ctx
  const scope = await resolvePendingScope(ctx)
  const emptyMigrations = await findEmptyMigrations(migrationsDir, scope.pending)
  const pluginsRewriteStatements = pluginRuntime.plugins.some((item) => item.plugin.hooks?.onBeforeApply !== undefined)
  const retry =
    retryTarget === undefined
      ? undefined
      : await resolveRetry(
          {
            migration: retryTarget,
            migrationsDir,
            pending: scope.pending,
            emptyMigrations,
            appliedNames,
            pluginsRewriteStatements,
          },
          { journalStore },
        )
  return { ...scope, emptyMigrations, retry }
}

/** Resolve the table scope and filter the pending set by it. */
async function resolvePendingScope(ctx: MigrateContext): Promise<ScopeResolution> {
  const { tableScope, migrationsDir, pendingAll } = ctx
  if (!tableScope.enabled) return { noScopeMatch: false, pending: pendingAll, undeterminedScope: [] }
  if (tableScope.matchCount === 0) return { noScopeMatch: true, pending: [], undeterminedScope: [] }
  const scoped = await filterPendingByScope(migrationsDir, pendingAll, new Set(tableScope.matchedTables))
  return { noScopeMatch: false, pending: scoped.inScope, undeterminedScope: scoped.undetermined }
}

/** Nothing to apply: say why, with what --retry did. */
export async function renderNothingPending(ctx: Pick<MigrateContext, 'jsonMode' | 'mode' | 'tableScope' | 'completeRecovery'>, plan: Pick<PendingPlan, 'noScopeMatch' | 'retry'>): Promise<number> {
  await ctx.completeRecovery?.()
  const { jsonMode, mode, tableScope } = ctx
  const input = { jsonMode, mode, scope: tableScope, retry: plan.retry }
  if (plan.noScopeMatch) emitNoScopeMatch(input)
  else emitNoPending(input)
  return 0
}

/** Render the pending plan (JSON early-return in plan mode, text otherwise). */
async function renderPlan(ctx: MigrateContext, plan: PendingPlan): Promise<number | undefined> {
  const { jsonMode, executeRequested, mode, tableScope, migrationsDir } = ctx
  const { pending, undeterminedScope, emptyMigrations, retry } = plan

  if (jsonMode && !executeRequested) {
    emitPlanJson({ mode, scope: tableScope, pending, undeterminedScope, emptyMigrations, retry })
    return 0
  }

  if (!jsonMode) {
    await renderPlanText({ migrationsDir, scope: tableScope, undeterminedScope, pending, emptyMigrations, retry })
  }

  return undefined
}

/** Gate: refuse to apply pending files without executable statements; a plan-only run just warns. */
function runEmptyMigrationGate(ctx: MigrateContext, emptyMigrations: string[]): number | undefined {
  const { executeRequested, jsonMode, mode, tableScope } = ctx
  if (emptyMigrations.length === 0) return undefined
  // A JSON plan already returned from renderPlan, so jsonMode here means --apply.
  const applyPossible = executeRequested || (!jsonMode && !isBackgroundOrCI())
  if (!applyPossible) return undefined
  if (jsonMode) {
    emitEmptyMigrationsBlockedJson({ mode, scope: tableScope, emptyMigrations })
    return 1
  }
  throw emptyMigrationsError(emptyMigrations)
}

/**
 * Gate: refuse to apply when a pending file marks a statement other than a
 * SELECT `mode=barrier` (#634), before any migration runs; a plan-only run
 * does not check.
 */
async function runBarrierGate(ctx: MigrateContext, pending: string[]): Promise<void> {
  const { executeRequested, jsonMode, migrationsDir } = ctx
  const applyPossible = executeRequested || (!jsonMode && !isBackgroundOrCI())
  if (!applyPossible) return
  const barriers = await findPendingNonSelectBarriers(migrationsDir, pending)
  if (barriers.length > 0) throw nonSelectBarrierError(barriers)
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
  const destructiveAllowed = allowDestructive || config.safety?.allowDestructive === true

  if (destructive.migrations.length > 0 && !destructiveAllowed) {
    const error =
      'Blocked destructive migration execution. Re-run with --allow-destructive or set safety.allowDestructive=true after review.'
    if (jsonMode) {
      emitDestructiveBlockedJson({ scope: tableScope, error, destructive })
      return 3
    }

    if (isBackgroundOrCI()) {
      printDestructiveOperationDetails(destructive.operations)
      console.error(
        `${error}\nDestructive migrations: ${destructive.migrations.join(', ')}\n` +
          'Non-interactive run detected. Pass --allow-destructive to proceed.',
      )
      return 3
    }

    const confirmed = await confirmDestructiveExecution(destructive.operations)
    if (!confirmed) {
      console.error(
        `Destructive migration cancelled by user.\nDestructive migrations: ${destructive.migrations.join(', ')}`,
      )
      return 3
    }
  }

  return undefined
}

/**
 * Apply each pending migration holding the migrate lock (#716), journal it,
 * and emit the final summary.
 */
async function applyPending(ctx: MigrateContext, plan: PendingPlan): Promise<number> {
  return await ctx.withLock(async () => await applyPlan(ctx, await replanUnderLock(ctx, plan)), plan.pending)
}

/**
 * The plan again, from the journal as it is now that this run holds the
 * lock: a run that held it meanwhile may have applied some of the pending
 * migrations, which this run then skips. Anything the plan the user saw does
 * not cover stops the run.
 */
async function replanUnderLock(ctx: MigrateContext, plan: PendingPlan): Promise<PendingPlan> {
  const journal = await ctx.journalStore.readJournal()
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const mismatches = await findChecksumMismatches(ctx.migrationsDir, journal)
  if (mismatches.length > 0) {
    throw journalChangedError(`the journal now records ${mismatches.map((item) => item.name).join(', ')} with another checksum`)
  }
  const current = await resolvePendingPlan({
    ...ctx,
    journal,
    appliedNames,
    pendingAll: ctx.files.filter((file) => !appliedNames.has(file)),
  })
  const added = current.pending.filter((file) => !plan.pending.includes(file))
  if (added.length > 0) throw journalChangedError(`${added.join(', ')} became pending`)
  if (JSON.stringify(current.retry) !== JSON.stringify(plan.retry)) {
    throw journalChangedError(`--retry ${ctx.retryTarget} now resolves differently`)
  }
  const skipped = plan.pending.filter((file) => !current.pending.includes(file))
  if (skipped.length > 0) {
    const line = `Skipping ${skipped.join(', ')}: another migrate run applied ${skipped.length === 1 ? 'it' : 'them'} meanwhile.`
    if (ctx.jsonMode) console.error(line)
    else console.log(line)
  }
  return current
}

async function applyPlan(ctx: MigrateContext, plan: PendingPlan): Promise<number> {
  const { jsonMode, migrationsDir, db, journalStore, pluginRuntime, config, tableScope, flags, settings } = ctx
  const { pending, undeterminedScope, retry } = plan
  // Progress lines go to stderr in --json mode, so stdout stays one JSON document.
  const log = jsonMode ? (line: string) => console.error(line) : (line: string) => console.log(line)

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
      settings,
      queryTracker: ctx.queryTracker(),
      retry: retry?.action === 'resume' && retry.migration === file ? retry : undefined,
      log,
    })
    appliedNow.push(entry)
    if (!jsonMode) renderApplied(file)
  }

  await ctx.completeRecovery?.()
  if (jsonMode) {
    emitApplySummaryJson({ scope: tableScope, applied: appliedNow, undeterminedScope, retry })
    return 0
  }

  renderApplySummary()
  return 0
}
