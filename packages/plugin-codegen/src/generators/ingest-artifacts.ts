import { dirname, relative } from 'node:path'

import {
  canonicalizeDefinitions,
  type TableDefinition,
} from '@chkit/core'

import type {
  GenerateIngestArtifactsInput,
  GenerateIngestArtifactsOutput,
} from '../types.js'
import { normalizeCodegenOptions } from '../options.js'
import { resolveTableNames } from '../naming.js'
import { renderHeader } from './shared.js'

function computeRelativeImportPath(fromFile: string, toFile: string): string {
  const fromDir = dirname(fromFile)
  let rel = relative(fromDir, toFile)
  if (!rel.startsWith('.')) rel = `./${rel}`
  // Replace .ts extension with .js for ESM imports
  return rel.replace(/\.ts$/, '.js')
}

function stripRowSuffix(name: string): string {
  if (name.endsWith('Row')) return name.slice(0, -3)
  if (name.endsWith('_row')) return name.slice(0, -4)
  return name
}

function renderIngestFunction(
  table: TableDefinition,
  interfaceName: string,
  emitZod: boolean
): string[] {
  const funcName = `ingest${stripRowSuffix(interfaceName)}`
  const tableFqn = `${table.database}.${table.name}`
  const lines: string[] = []

  if (emitZod) {
    lines.push(`export async function ${funcName}(`)
    lines.push(`  ingestor: Ingestor,`)
    lines.push(`  rows: ${interfaceName}[],`)
    lines.push(`  options?: IngestOptions`)
    lines.push(`): Promise<void> {`)
    lines.push(`  const data = options?.validate ? rows.map(row => ${interfaceName}Schema.parse(row)) : rows`)
    lines.push(`  await ingestor.insert({ table: '${tableFqn}', values: data, compressed: options?.compressed ?? true })`)
    lines.push(`}`)
  } else {
    lines.push(`export async function ${funcName}(`)
    lines.push(`  ingestor: Ingestor,`)
    lines.push(`  rows: ${interfaceName}[],`)
    lines.push(`  options?: IngestOptions`)
    lines.push(`): Promise<void> {`)
    lines.push(`  await ingestor.insert({ table: '${tableFqn}', values: rows, compressed: options?.compressed ?? true })`)
    lines.push(`}`)
  }

  return lines
}

export function generateIngestArtifacts(
  input: GenerateIngestArtifactsInput
): GenerateIngestArtifactsOutput {
  const normalized = normalizeCodegenOptions(input.options)
  const definitions = canonicalizeDefinitions(input.definitions)
  const tables = definitions
    .filter((definition): definition is TableDefinition => definition.kind === 'table')
    .sort((a, b) => {
      if (a.database !== b.database) return a.database.localeCompare(b.database)
      return a.name.localeCompare(b.name)
    })

  const resolved = resolveTableNames(tables, normalized.tableNameStyle)
  const importPath = computeRelativeImportPath(normalized.ingestOutFile, normalized.outFile)

  const typeImports: string[] = []
  const valueImports: string[] = []
  for (const entry of resolved) {
    typeImports.push(entry.interfaceName)
    if (normalized.emitZod) {
      valueImports.push(`${entry.interfaceName}Schema`)
    }
  }

  const header = renderHeader(input.toolVersion ?? '0.1.0')
  const lines = [...header, '']

  if (typeImports.length > 0) {
    lines.push(`import type { ${typeImports.join(', ')} } from '${importPath}'`)
  }
  if (valueImports.length > 0) {
    lines.push(`import { ${valueImports.join(', ')} } from '${importPath}'`)
  }

  lines.push('')
  lines.push('export interface Ingestor {')
  lines.push('  insert(params: { table: string; values: Record<string, unknown>[]; compressed?: boolean }): Promise<void>')
  lines.push('}')
  lines.push('')
  lines.push('export interface IngestOptions {')
  lines.push('  compressed?: boolean')
  if (normalized.emitZod) {
    lines.push('  validate?: boolean')
  }
  lines.push('}')

  for (const entry of resolved) {
    if (entry.definition.kind !== 'table') continue
    lines.push('')
    lines.push(...renderIngestFunction(entry.definition, entry.interfaceName, normalized.emitZod))
  }

  const content = `${lines.join('\n').trimEnd()}\n`

  return {
    content,
    outFile: normalized.ingestOutFile,
    functionCount: resolved.length,
  }
}
