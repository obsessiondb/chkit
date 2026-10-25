import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import type { ResolvedChxConfig } from '@chkit/core'
import * as Effect from 'effect/Effect'
import {
  type ChxPluginCommand,
  type ChxPluginCommandContext,
  defineFlags,
  type ParsedFlags,
  type PluginRuntime,
  type TableScope,
  typedFlags,
} from '../../plugins.js'
import { resolveDirs } from '../../runtime/config.js'
import { debug } from '../../runtime/debug.js'
import { fromPromise, runEffect } from '../../runtime/effect.js'
import { GLOBAL_FLAGS } from '../../runtime/global-flags.js'
import { createJournalStore } from '../../runtime/journal-store.js'
import {
  findChecksumMismatches,
  listMigrations,
  type MigrationJournal,
  type MigrationJournalEntry,
  readSnapshot,
} from '../../runtime/migration-store.js'
import { resolveTableScope, tableKeysFromDefinitions } from '../../runtime/table-scope.js'

import { abandonMigrationState, abandonReport, readAbandonableState } from './abandon.js'
import { applyMigration } from './apply.js'
import { scanDestructive } from './destructive.js'
import { findEmptyMigrations } from './empty.js'
import { emptyMigrationsError, MigrateError } from './errors.js'
import {
  emitAbandonJson,
  emitApplySummaryJson,
  emitChecksumMismatchJson,
  emitDestructiveBlockedJson,
  emitEmptyMigrationsBlockedJson,
  emitNoPending,
  emitNoScopeMatch,
  emitPlanJson,
  type MigrateMode,
  renderAbandonPlanOnlyNotice,
  renderAbandonText,
  renderApplied,
  renderApplySummary,
  renderMigrationLog,
  renderPlanOnlyNotice,
  renderPlanText,
} from './output.js'
import {
  confirmAbandon,
  confirmApply,
  confirmDestructiveExecution,
  isBackgroundOrCI,
  printDestructiveOperationDetails,
} from './prompts.js'
import { resolveRecoveryTargets } from './recovery.js'
import { type RetryResolution, resolveRetry } from './retry.js'
import { filterPendingByScope } from './scope.js'

const MIGRATE_FLAGS = defineFlags([
  {
    name: '--apply',
    type: 'boolean',
    description: 'Apply pending migrations on ClickHouse (no prompt)',
  },
  { name: '--execute', type: 'boolean', description: 'Alias for --apply' },
  {
    name: '--allow-destructive',
    type: 'boolean',
    description: 'Allow destructive migrations tagged with risk=danger',
  },
  {
    name: '--retry',
    type: 'string',
    description: 'Resume a failed migration after editing its file (skips completed statements)',
    placeholder: '<migration>',
  },
  {
    name: '--abandon',
    type: 'string',
    description:
      'Reset a failed migration so the next apply runs it from statement 1 (journal only; previews without --apply)',
    placeholder: '<migration>',
  },
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
}

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
>

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

function cmdMigrate(runCtx: ChxPluginCommandContext): Promise<undefined | number> {
  return runEffect(
    Effect.gen(function* () {
      const ctx = yield* prepareMigration(runCtx)
      const abandonTarget = ctx.abandonTarget
      if (abandonTarget !== undefined) return yield* fromPromise(() => runAbandon(ctx, abandonTarget))

      const checksumExit = yield* runChecksumGate(ctx)
      if (checksumExit !== undefined) return checksumExit

      const plan = yield* resolvePendingPlan(ctx)
      if (plan.pending.length === 0) return renderNothingPending(ctx, plan)

      const planExit = yield* renderPlan(ctx, plan)
      if (planExit !== undefined) return planExit

      const emptyExit = runEmptyMigrationGate(ctx, plan.emptyMigrations)
      if (emptyExit !== undefined) return emptyExit

      const confirmExit = yield* runConfirmGate(ctx)
      if (confirmExit !== undefined) return confirmExit

      const destructiveExit = yield* runDestructiveGate(ctx, plan.pending)
      if (destructiveExit !== undefined) return destructiveExit

      return yield* applyPending(ctx, plan)
    }),
  )
}

/** Parse flags, resolve deps, run onConfigLoaded, and load the pending set. */
function prepareMigration(runCtx: ChxPluginCommandContext): Effect.Effect<MigrateContext, unknown> {
  return Effect.gen(function* () {
    const { flags, config, configPath, pluginRuntime, pluginContext } = runCtx
    const f = typedFlags(flags, [...GLOBAL_FLAGS, ...MIGRATE_FLAGS] as const)
    const executeRequested = f['--apply'] === true || f['--execute'] === true
    const allowDestructive = f['--allow-destructive'] === true
    const tableSelector = f['--table']
    const jsonMode = f['--json'] === true
    const { retryTarget, abandonTarget } = resolveRecoveryTargets(flags)

    const { migrationsDir, metaDir } = resolveDirs(config)
    debug(
      'migrate',
      `flags: execute=${executeRequested}, allowDestructive=${allowDestructive}, json=${jsonMode}, ` +
        `retry=${retryTarget ?? '-'}, abandon=${abandonTarget ?? '-'}`,
    )

    if (!pluginContext.hasExecutor) {
      return yield* Effect.fail(
        new Error('clickhouse config is required for migrate (journal is stored in ClickHouse)'),
      )
    }
    const db = pluginContext.executor
    const journalStore = createJournalStore(db, config.clickhouse?.cluster)
    // --abandon only changes the journal and rejects --table, so it does not
    // read snapshot.json: a conflicted snapshot cannot block it.
    const snapshot = abandonTarget === undefined ? yield* fromPromise(() => readSnapshot(metaDir)) : null
    const tableScope = resolveTableScope(tableSelector, tableKeysFromDefinitions(snapshot?.definitions ?? []))
    const mode: MigrateMode = executeRequested ? 'execute' : 'plan'

    yield* fromPromise(() =>
      pluginRuntime.runOnConfigLoaded({
        command: 'migrate',
        config,
        configPath,
        tableScope,
        flags,
      }),
    )

    yield* fromPromise(() => mkdir(migrationsDir, { recursive: true }))
    const files = yield* fromPromise(() => listMigrations(migrationsDir))
    if (retryTarget !== undefined && !files.includes(retryTarget)) {
      return yield* Effect.fail(
        new MigrateError(
          'migration_not_found',
          `--retry: no migration file named ${retryTarget} in ${migrationsDir}. To reset the journal state of a migration whose file was deleted, use chkit migrate --abandon ${retryTarget}.`,
        ),
      )
    }
    const journal = yield* fromPromise(() => journalStore.readJournal())
    const appliedNames = new Set(journal.applied.map((entry) => entry.name))
    const pendingAll = files.filter((file) => !appliedNames.has(file))
    debug(
      'migrate',
      `migrations: total=${files.length}, applied=${journal.applied.length}, pending=${pendingAll.length}`,
    )

    return {
      jsonMode,
      executeRequested,
      allowDestructive,
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
    }
  })
}

/**
 * --abandon <migration>: reset the journal state of a failed migration so the
 * next apply runs it from statement 1. Without --apply it only previews, like
 * the rest of migrate, or asks first in an interactive terminal. Runs before
 * every other gate and applies nothing.
 */
export function runAbandon(
  ctx: AbandonContext,
  migration: string,
  prompt: AbandonPrompt = TERMINAL_PROMPT,
): Promise<number> {
  return runEffect(
    Effect.gen(function* () {
      const { jsonMode, executeRequested, journalStore, tableScope } = ctx
      const state = yield* fromPromise(() =>
        readAbandonableState({ migration, appliedNames: ctx.appliedNames }, { journalStore }),
      )
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
        if (!(yield* fromPromise(() => prompt.confirm(migration)))) {
          console.log('Abandon cancelled by user.')
          return 0
        }
        yield* fromPromise(() => abandonMigrationState(state, { journalStore }))
        console.log(`Abandoned in-progress migration ${migration}.`)
        return 0
      }

      yield* fromPromise(() => abandonMigrationState(state, { journalStore }))
      if (jsonMode) {
        emitAbandonJson({ mode: 'execute', scope: tableScope, abandon: report })
        return 0
      }
      renderAbandonText(report, { ...textInput, performed: true })
      return 0
    }),
  )
}

/** Gate 1: block when applied migrations no longer match their recorded checksum. */
function runChecksumGate(ctx: MigrateContext): Effect.Effect<number | undefined, unknown> {
  return Effect.gen(function* () {
    const { migrationsDir, journal, jsonMode, mode, tableScope } = ctx
    const checksumMismatches = yield* fromPromise(() => findChecksumMismatches(migrationsDir, journal))
    if (checksumMismatches.length === 0) return undefined

    debug('migrate', `checksum mismatches: ${checksumMismatches.map((m) => m.name).join(', ')}`)
    if (jsonMode) {
      emitChecksumMismatchJson({ mode, scope: tableScope, checksumMismatches })
      return 1
    }
    return yield* Effect.fail(
      new Error(
        `Checksum mismatch detected on applied migrations: ${checksumMismatches.map((item) => item.name).join(', ')}`,
      ),
    )
  })
}

/**
 * Filter the pending set by table scope, find the files without statements,
 * and resolve --retry, before any gate runs. --retry is resolved even when
 * nothing is pending, so every run reports what it did.
 */
function resolvePendingPlan(ctx: MigrateContext): Effect.Effect<PendingPlan, unknown> {
  return Effect.gen(function* () {
    const { migrationsDir, retryTarget, journalStore, appliedNames } = ctx
    const scope = yield* resolvePendingScope(ctx)
    const emptyMigrations = yield* fromPromise(() => findEmptyMigrations(migrationsDir, scope.pending))
    const retry =
      retryTarget === undefined
        ? undefined
        : yield* fromPromise(() =>
            resolveRetry(
              {
                migration: retryTarget,
                migrationsDir,
                pending: scope.pending,
                emptyMigrations,
                appliedNames,
              },
              { journalStore },
            ),
          )
    return { ...scope, emptyMigrations, retry }
  })
}

/** Resolve the table scope and filter the pending set by it. */
function resolvePendingScope(ctx: MigrateContext): Effect.Effect<ScopeResolution, unknown> {
  return Effect.gen(function* () {
    const { tableScope, migrationsDir, pendingAll } = ctx
    if (!tableScope.enabled) return { noScopeMatch: false, pending: pendingAll, undeterminedScope: [] }
    if (tableScope.matchCount === 0) return { noScopeMatch: true, pending: [], undeterminedScope: [] }
    const scoped = yield* fromPromise(() =>
      filterPendingByScope(migrationsDir, pendingAll, new Set(tableScope.matchedTables)),
    )
    return {
      noScopeMatch: false,
      pending: scoped.inScope,
      undeterminedScope: scoped.undetermined,
    }
  })
}

/** Nothing to apply: say why, with what --retry did. */
function renderNothingPending(ctx: MigrateContext, plan: PendingPlan): number {
  const { jsonMode, mode, tableScope } = ctx
  const input = { jsonMode, mode, scope: tableScope, retry: plan.retry }
  if (plan.noScopeMatch) emitNoScopeMatch(input)
  else emitNoPending(input)
  return 0
}

/** Render the pending plan (JSON early-return in plan mode, text otherwise). */
function renderPlan(ctx: MigrateContext, plan: PendingPlan): Effect.Effect<number | undefined, unknown> {
  return Effect.gen(function* () {
    const { jsonMode, executeRequested, mode, tableScope, migrationsDir } = ctx
    const { pending, undeterminedScope, emptyMigrations, retry } = plan

    if (jsonMode && !executeRequested) {
      emitPlanJson({
        mode,
        scope: tableScope,
        pending,
        undeterminedScope,
        emptyMigrations,
        retry,
      })
      return 0
    }

    if (!jsonMode) {
      yield* fromPromise(() =>
        renderPlanText({
          migrationsDir,
          scope: tableScope,
          undeterminedScope,
          pending,
          emptyMigrations,
          retry,
        }),
      )
    }

    return undefined
  })
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

/** Gate 2: in plan mode, stop unless the user confirms an interactive apply. */
function runConfirmGate(ctx: MigrateContext): Effect.Effect<number | undefined, unknown> {
  return Effect.gen(function* () {
    const { executeRequested, jsonMode } = ctx
    if (executeRequested) return undefined

    if (isBackgroundOrCI() || jsonMode) {
      if (!jsonMode) renderPlanOnlyNotice()
      return 0
    }

    const confirmed = yield* fromPromise(() => confirmApply())
    if (!confirmed) {
      console.log('Migration apply cancelled by user.')
      return 0
    }
    return undefined
  })
}

/** Gate 3: block destructive migrations unless allowed, confirmed, or forced. */
function runDestructiveGate(ctx: MigrateContext, pending: string[]): Effect.Effect<number | undefined, unknown> {
  return Effect.gen(function* () {
    const { migrationsDir, allowDestructive, config, jsonMode, tableScope } = ctx
    const destructive = yield* fromPromise(() => scanDestructive(migrationsDir, pending))
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
        return yield* Effect.fail(
          new Error(
            `${error}\nDestructive migrations: ${destructive.migrations.join(', ')}\n` +
              'Non-interactive run detected. Pass --allow-destructive to proceed.',
          ),
        )
      }

      const confirmed = yield* fromPromise(() => confirmDestructiveExecution(destructive.operations))
      if (!confirmed) {
        return yield* Effect.fail(
          new Error(
            `Destructive migration cancelled by user.\nDestructive migrations: ${destructive.migrations.join(', ')}`,
          ),
        )
      }
      destructiveAllowed = true
    }

    if (destructive.migrations.length > 0 && !destructiveAllowed) {
      return yield* Effect.fail(new Error('Blocked destructive migration execution.'))
    }

    return undefined
  })
}

/** Apply each pending migration, journal it, and emit the final summary. */
function applyPending(ctx: MigrateContext, plan: PendingPlan): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    const { jsonMode, migrationsDir, db, journalStore, pluginRuntime, config, tableScope, flags } = ctx
    const { pending, undeterminedScope, retry } = plan
    // Progress lines go to stderr in --json mode, so stdout stays one JSON document.
    const log = jsonMode ? (line: string) => console.error(line) : (line: string) => console.log(line)

    const appliedNow: MigrationJournalEntry[] = []
    for (const file of pending) {
      if (!jsonMode) yield* fromPromise(() => renderMigrationLog(migrationsDir, file))
      const entry = yield* fromPromise(() =>
        applyMigration({
          db,
          journalStore,
          pluginRuntime,
          config,
          tableScope,
          flags,
          migrationsDir,
          file,
          retry: retry?.action === 'resume' && retry.migration === file ? retry : undefined,
          log,
        }),
      )
      appliedNow.push(entry)
      if (!jsonMode) renderApplied(file)
    }

    if (jsonMode) {
      emitApplySummaryJson({
        scope: tableScope,
        applied: appliedNow,
        undeterminedScope,
        retry,
      })
      return 0
    }

    renderApplySummary()
    return 0
  })
}
