import { readFile } from 'node:fs/promises'
import process from 'node:process'

import fg from 'fast-glob'

import { canonicalizeDefinitions, collectDefinitionsFromModule } from './canonical.js'
import { hasConflictMarkers } from './conflict-markers.js'
import type { SchemaDefinition } from './model.js'
import { importModuleFile } from './ts-import.js'

export interface SchemaLoaderOptions {
  cwd?: string
}

/** Where Bun's parser reports an error (`BuildMessage.position`). */
interface SourcePosition {
  file: string
  line: number
  column: number
}

/**
 * The `<file>:<line>:<column>` line that jiti, the loader under Node, ends a
 * parse error's message with. The file path can contain spaces.
 */
const MESSAGE_LOCATION_LINE = /^[ \t]*(.+):\d+:\d+[ \t]*$/gm

export async function loadSchemaDefinitions(
  schemaGlobs: string | string[],
  options: SchemaLoaderOptions = {}
): Promise<SchemaDefinition[]> {
  const modules = await loadDefinitionModules(schemaGlobs, options)
  return canonicalizeDefinitions(modules.flatMap(collectDefinitionsFromModule))
}

/** Load configured entry/schema modules so plugins can inspect their exported definitions. */
export async function loadDefinitionModules(
  schemaGlobs: string | string[],
  options: SchemaLoaderOptions = {}
): Promise<Record<string, unknown>[]> {
  const patterns = Array.isArray(schemaGlobs) ? schemaGlobs : [schemaGlobs]
  const files = await fg(patterns, {
    cwd: options.cwd ?? process.cwd(),
    absolute: true,
  })

  if (files.length === 0) {
    throw new Error('No schema files matched. Check config.schema patterns.')
  }

  const modules: Record<string, unknown>[] = []
  for (const file of files) modules.push(await importSchemaFile(file))
  return modules
}

/** Import one schema file. A failure names the file, and points out git conflict markers. */
async function importSchemaFile(file: string): Promise<Record<string, unknown>> {
  try {
    return await importModuleFile(file)
  } catch (error) {
    throw new Error(await describeImportFailure(file, error), { cause: error })
  }
}

async function describeImportFailure(file: string, error: unknown): Promise<string> {
  const failures = errorEntries(error)
  const summary = `Failed to load schema file ${file}: ${failures.map(describeErrorEntry).join('; ')}`
  // The parser names the file that failed to parse, which can be a module the schema file imports.
  const conflicted = await findConflictedFile([file, ...failures.flatMap(reportedFiles)])
  if (conflicted === undefined) return summary
  const holder = conflicted === file ? 'The file' : conflicted
  return `${summary}\n${holder} contains unresolved merge conflict markers. Resolve the conflict and run the command again.`
}

async function findConflictedFile(files: string[]): Promise<string | undefined> {
  for (const file of new Set(files)) {
    if (hasConflictMarkers(await readFile(file, 'utf8').catch(() => ''))) return file
  }
  return undefined
}

/** The individual errors behind `error`: Bun reports several parse errors as one AggregateError. */
function errorEntries(error: unknown): unknown[] {
  if (isRecord(error) && Array.isArray(error.errors) && error.errors.length > 0) return error.errors
  return [error]
}

function describeErrorEntry(entry: unknown): string {
  const message = messageOf(entry)
  const position = positionOf(entry)
  return position ? `${message} (${position.file}:${position.line}:${position.column})` : message
}

/** The files an error names as failing: Bun's position, or the location line of jiti's message under Node. */
function reportedFiles(entry: unknown): string[] {
  const located = [...messageOf(entry).matchAll(MESSAGE_LOCATION_LINE)].flatMap((match) => match[1] ?? [])
  const position = positionOf(entry)
  return position ? [position.file, ...located] : located
}

function messageOf(entry: unknown): string {
  return isRecord(entry) && typeof entry.message === 'string' && entry.message !== '' ? entry.message : String(entry)
}

function positionOf(entry: unknown): SourcePosition | undefined {
  if (!isRecord(entry) || !isRecord(entry.position)) return undefined
  const { file, line, column } = entry.position
  if (typeof file !== 'string' || typeof line !== 'number' || typeof column !== 'number') return undefined
  return { file, line, column }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
