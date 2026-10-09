import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeSnapshot } from '@chkit/codegen'
import {
  canonicalizeDefinitions,
  ChxValidationError,
  validateDefinitions,
  type ParsedFlags,
  type ResolvedChxConfig,
  type SchemaDefinition,
} from '@chkit/core'

import type { PluginRuntime } from '../../plugins.js'
import { resolveDirs } from '../../runtime/config.js'
import { emitJson } from '../../runtime/json-output.js'
import { loadSchemaDefinitionsWithHooks } from '../../runtime/schema-loader.js'
import {
  diffSnapshotDefinitions,
  parseSnapshotDocument,
  type ParsedSnapshotDocument,
} from '../../runtime/snapshot-document.js'
import { emitSnapshotRebuildOutput, type PreviousSnapshotReport } from './output.js'

export interface SnapshotRebuildInput {
  dryrun: boolean
  jsonMode: boolean
}

export interface SnapshotRebuildDeps {
  config: ResolvedChxConfig
  configPath: string
  flags: ParsedFlags
  pluginRuntime: PluginRuntime
}

/**
 * Rewrite snapshot.json from the schema definitions. Definitions are loaded,
 * passed through the plugin hooks, validated and written exactly as
 * `chkit generate` does; no migration is planned or written.
 */
export async function runSnapshotRebuild(input: SnapshotRebuildInput, deps: SnapshotRebuildDeps): Promise<number> {
  const { metaDir } = resolveDirs(deps.config)
  const snapshotFile = join(metaDir, 'snapshot.json')

  const loaded = await loadSchemaDefinitionsWithHooks(
    {
      command: 'snapshot',
      config: deps.config,
      configPath: deps.configPath,
      flags: deps.flags,
      jsonMode: input.jsonMode,
    },
    { pluginRuntime: deps.pluginRuntime },
  )
  // A hook that edits definitions in place (instead of returning them) leaves
  // them non-canonical. The snapshot always stores canonical definitions, so
  // canonicalize once and validate, compare, count and write that same list.
  const definitions = canonicalizeDefinitions(loaded)

  // Same validation and error contract as `chkit generate` (planDiff validates the new definitions).
  const issues = validateDefinitions(definitions)
  if (issues.length > 0) {
    if (input.jsonMode) {
      emitJson('snapshot', { error: 'validation_failed', issues })
      return 1
    }
    const details = issues.map((issue) => `- [${issue.code}] ${issue.message}`).join('\n')
    throw new Error(`${new ChxValidationError(issues).message}\n${details}`)
  }

  const previous = await describePreviousSnapshot(snapshotFile, definitions)
  const upToDate =
    previous.status === 'parsed' &&
    previous.added.length + previous.removed.length + previous.changed.length === 0
  // An unchanged snapshot is left alone, so a rebuild never churns `generatedAt`.
  const written = !input.dryrun && !upToDate
  if (written) await writeSnapshot({ metaDir, definitions })

  emitSnapshotRebuildOutput(
    {
      subcommand: 'rebuild',
      mode: input.dryrun ? 'plan' : 'write',
      snapshotFile,
      written,
      definitionCount: definitions.length,
      previous,
    },
    input.jsonMode,
  )
  return 0
}

async function describePreviousSnapshot(
  snapshotFile: string,
  next: SchemaDefinition[],
): Promise<PreviousSnapshotReport> {
  if (!existsSync(snapshotFile)) return { status: 'missing' }
  const raw = await readFile(snapshotFile, 'utf8')

  let parsed: ParsedSnapshotDocument
  try {
    parsed = parseSnapshotDocument(raw)
  } catch {
    // Valid JSON whose entries cannot be read as chkit definitions. The rebuild
    // replaces it anyway; it just cannot be compared.
    return { status: 'unreadable', reason: 'invalid_shape' }
  }

  if (parsed.status === 'ok') {
    return { status: 'parsed', ...diffSnapshotDefinitions(parsed.snapshot.definitions, next) }
  }
  if (parsed.reason === 'conflict_markers') return { status: 'conflicted' }
  return { status: 'unreadable', reason: parsed.reason }
}
