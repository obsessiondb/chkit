import { dirname, relative } from 'node:path'

import {
  canonicalizeDefinitions,
  insertColumnList,
  type TableDefinition,
} from '@chkit/core'

import type {
  GenerateIngestArtifactsInput,
  GenerateIngestArtifactsOutput,
} from '../types.js'
import { normalizeCodegenOptions } from '../options.js'
import { resolveTableNames } from '../naming.js'
import { insertTypeName, renderHeader } from './shared.js'

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
  const inputType = insertTypeName(table, interfaceName)
  const columns = insertColumnList(table)
  const columnsPart = columns ? `, columns: [${columns.map(renderStringLiteral).join(', ')}]` : ''
  const lines: string[] = []

  if (emitZod) {
    lines.push(`export async function ${funcName}(`)
    lines.push(`  ingestor: Ingestor,`)
    lines.push(`  rows: ${inputType}[],`)
    lines.push(`  options?: IngestOptions`)
    lines.push(`): Promise<void> {`)
    lines.push(`  const data = options?.validate ? rows.map(row => ${inputType}Schema.parse(row)) : rows`)
    lines.push(`  await ingestor.insert({ table: '${tableFqn}', values: data${columnsPart}, compressed: options?.compressed ?? true })`)
    lines.push(`}`)
  } else {
    lines.push(`export async function ${funcName}(`)
    lines.push(`  ingestor: Ingestor,`)
    lines.push(`  rows: ${inputType}[],`)
    lines.push(`  options?: IngestOptions`)
    lines.push(`): Promise<void> {`)
    lines.push(`  await ingestor.insert({ table: '${tableFqn}', values: rows${columnsPart}, compressed: options?.compressed ?? true })`)
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
    const name = entry.definition.kind === 'table'
      ? insertTypeName(entry.definition, entry.interfaceName)
      : entry.interfaceName
    typeImports.push(name)
    if (normalized.emitZod) {
      valueImports.push(`${name}Schema`)
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
  // Only schemas with EPHEMERAL inputs need a column list; others keep their output unchanged.
  if (tables.some(hasEphemeralColumns)) {
    lines.push('  /** Forward `columns` as the INSERT column list: without it ClickHouse drops EPHEMERAL inputs. */')
    lines.push('  insert(params: { table: string; values: Record<string, unknown>[]; compressed?: boolean; columns?: string[] }): Promise<void>')
  } else {
    lines.push('  insert(params: { table: string; values: Record<string, unknown>[]; compressed?: boolean }): Promise<void>')
  }
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

function hasEphemeralColumns(table: TableDefinition): boolean {
  return table.columns.some((column) => column.defaultKind === 'EPHEMERAL')
}

function renderStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
