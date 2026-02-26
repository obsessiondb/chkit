import { dirname, relative } from 'node:path'

import {
  canonicalizeDefinitions,
  type ColumnDefinition,
  type MaterializedViewDefinition,
  type TableDefinition,
  type ViewDefinition,
} from '@chkit/core'

import type {
  CodegenFinding,
  CodegenPluginOptions,
  GenerateIngestArtifactsInput,
  GenerateIngestArtifactsOutput,
  GenerateTypeArtifactsInput,
  GenerateTypeArtifactsOutput,
  MapColumnTypeResult,
} from './types.js'
import { UnsupportedTypeError } from './errors.js'
import { normalizeCodegenOptions } from './options.js'
import { renderPropertyName, resolveTableNames } from './naming.js'

const LARGE_INTEGER_TYPES = new Set([
  'Int64',
  'UInt64',
  'Int128',
  'UInt128',
  'Int256',
  'UInt256',
])

const NUMBER_TYPES = new Set([
  'Int8',
  'Int16',
  'Int32',
  'UInt8',
  'UInt16',
  'UInt32',
  'Float32',
  'Float64',
  'BFloat16',
])

const STRING_TYPES = new Set([
  'String',
  'FixedString',
  'Date',
  'Date32',
  'DateTime',
  'DateTime64',
  'UUID',
  'IPv4',
  'IPv6',
  'Enum',
  'Enum8',
  'Enum16',
  'Decimal',
  'Decimal32',
  'Decimal64',
  'Decimal128',
  'Decimal256',
])

const BOOLEAN_TYPES = new Set(['Bool', 'Boolean'])

function splitTopLevelArgs(input: string): string[] {
  const args: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      args.push(input.slice(start, i).trim())
      start = i + 1
    }
  }

  const last = input.slice(start).trim()
  if (last.length > 0) args.push(last)
  return args
}

function parseClickHouseType(typeStr: string): { base: string; args: string[] } {
  const trimmed = typeStr.trim()
  const parenIndex = trimmed.indexOf('(')
  if (parenIndex < 0) return { base: trimmed, args: [] }

  const base = trimmed.slice(0, parenIndex)
  const closingParen = trimmed.lastIndexOf(')')
  if (closingParen <= parenIndex) return { base: trimmed, args: [] }

  const inner = trimmed.slice(parenIndex + 1, closingParen)
  if (inner.trim().length === 0) return { base, args: [] }
  return { base, args: splitTopLevelArgs(inner) }
}

function mapScalarType(base: string, bigintMode: Required<CodegenPluginOptions>['bigintMode']): string | null {
  if (STRING_TYPES.has(base)) return 'string'
  if (BOOLEAN_TYPES.has(base)) return 'boolean'
  if (NUMBER_TYPES.has(base)) return 'number'
  if (LARGE_INTEGER_TYPES.has(base)) return bigintMode
  return null
}

function scalarToZod(mapped: string): string {
  if (mapped === 'string') return 'z.string()'
  if (mapped === 'number') return 'z.number()'
  if (mapped === 'boolean') return 'z.boolean()'
  if (mapped === 'bigint') return 'z.bigint()'
  return 'z.unknown()'
}

function resolveInnerType(
  typeStr: string,
  bigintMode: Required<CodegenPluginOptions>['bigintMode']
): { tsType: string; zodType: string } | null {
  const parsed = parseClickHouseType(typeStr)

  const scalar = mapScalarType(parsed.base, bigintMode)
  if (scalar) return { tsType: scalar, zodType: scalarToZod(scalar) }

  switch (parsed.base) {
    case 'Nullable': {
      const arg = parsed.args[0]
      if (!arg) return null
      const inner = resolveInnerType(arg, bigintMode)
      if (!inner) return null
      return { tsType: `${inner.tsType} | null`, zodType: `${inner.zodType}.nullable()` }
    }
    case 'LowCardinality': {
      const arg = parsed.args[0]
      if (!arg) return null
      return resolveInnerType(arg, bigintMode)
    }
    case 'Array': {
      const arg = parsed.args[0]
      if (!arg) return null
      const inner = resolveInnerType(arg, bigintMode)
      if (!inner) return null
      const needsWrap = inner.tsType.includes('|')
      const tsType = needsWrap ? `(${inner.tsType})[]` : `${inner.tsType}[]`
      return { tsType, zodType: `z.array(${inner.zodType})` }
    }
    case 'Map': {
      const keyArg = parsed.args[0]
      const valueArg = parsed.args[1]
      if (!keyArg || !valueArg) return null
      const key = resolveInnerType(keyArg, bigintMode)
      const value = resolveInnerType(valueArg, bigintMode)
      if (!key || !value) return null
      return {
        tsType: `Record<${key.tsType}, ${value.tsType}>`,
        zodType: `z.record(${key.zodType}, ${value.zodType})`,
      }
    }
    case 'Tuple': {
      if (parsed.args.length === 0) return null
      const elements = parsed.args.map((a) => resolveInnerType(a, bigintMode))
      if (elements.some((e) => e === null)) return null
      const valid = elements as { tsType: string; zodType: string }[]
      return {
        tsType: `[${valid.map((e) => e.tsType).join(', ')}]`,
        zodType: `z.tuple([${valid.map((e) => e.zodType).join(', ')}])`,
      }
    }
    case 'SimpleAggregateFunction': {
      const lastArg = parsed.args[parsed.args.length - 1]
      if (parsed.args.length < 2 || !lastArg) return null
      return resolveInnerType(lastArg, bigintMode)
    }
    case 'JSON': {
      return { tsType: 'Record<string, unknown>', zodType: 'z.record(z.string(), z.unknown())' }
    }
    default:
      return null
  }
}

function resolveColumnType(
  typeStr: string,
  bigintMode: Required<CodegenPluginOptions>['bigintMode']
): { tsType: string; zodType: string; nullable: boolean } | null {
  const parsed = parseClickHouseType(typeStr)

  const firstArg = parsed.args[0]

  if (parsed.base === 'LowCardinality' && firstArg) {
    return resolveColumnType(firstArg, bigintMode)
  }

  if (parsed.base === 'Nullable' && firstArg) {
    const inner = resolveColumnType(firstArg, bigintMode)
    if (!inner) return null
    return { tsType: inner.tsType, zodType: inner.zodType, nullable: true }
  }

  const resolved = resolveInnerType(typeStr, bigintMode)
  if (!resolved) return null
  return { tsType: resolved.tsType, zodType: resolved.zodType, nullable: false }
}

export function mapColumnType(
  input: { column: ColumnDefinition; path: string },
  options: Pick<Required<CodegenPluginOptions>, 'bigintMode' | 'failOnUnsupportedType'>
): MapColumnTypeResult {
  const resolved = resolveColumnType(input.column.type, options.bigintMode)
  const columnNullable = input.column.nullable === true

  if (!resolved) {
    if (options.failOnUnsupportedType) {
      throw new UnsupportedTypeError(input.path, input.column.type)
    }
    const unknownType = columnNullable ? 'unknown | null' : 'unknown'
    return {
      tsType: unknownType,
      zodType: 'z.unknown()',
      nullable: columnNullable,
      finding: {
        code: 'codegen_unsupported_type',
        message: `Unsupported type "${input.column.type}" at ${input.path}; emitted unknown.`,
        severity: 'warn',
        path: input.path,
      },
    }
  }

  const nullable = columnNullable || resolved.nullable
  const tsType = nullable ? `${resolved.tsType} | null` : resolved.tsType
  return { tsType, zodType: resolved.zodType, nullable }
}

function renderHeader(toolVersion: string): string[] {
  const lines = [
    '// This file is auto-generated by chkit codegen — do not edit manually.',
  ]
  lines.push(`// chkit-codegen-version: ${toolVersion}`)
  return lines
}

function renderTableInterface(
  table: TableDefinition,
  interfaceName: string,
  options: Required<CodegenPluginOptions>
): { lines: string[]; findings: CodegenFinding[] } {
  const lines: string[] = [`export interface ${interfaceName} {`]
  const findings: CodegenFinding[] = []
  const zodFields: string[] = []

  for (const column of table.columns) {
    const path = `${table.database}.${table.name}.${column.name}`
    const mapped = mapColumnType({ column, path }, options)
    if (mapped.finding) findings.push(mapped.finding)
    lines.push(`  ${renderPropertyName(column.name)}: ${mapped.tsType}`)
    const zodExpr = mapped.nullable ? `${mapped.zodType}.nullable()` : mapped.zodType
    zodFields.push(`  ${renderPropertyName(column.name)}: ${zodExpr},`)
  }

  lines.push('}')
  if (options.emitZod) {
    lines.push('')
    lines.push(`export const ${interfaceName}Schema = z.object({`)
    lines.push(...zodFields)
    lines.push('})')
    lines.push('')
    lines.push(`export type ${interfaceName}Input = z.input<typeof ${interfaceName}Schema>`)
    lines.push(`export type ${interfaceName}Output = z.output<typeof ${interfaceName}Schema>`)
  }
  return { lines, findings }
}

function renderViewInterface(
  definition: ViewDefinition | MaterializedViewDefinition,
  interfaceName: string
): { lines: string[]; findings: CodegenFinding[] } {
  const kind = definition.kind === 'view' ? 'view' : 'materialized_view'
  return {
    lines: [
      `export interface ${interfaceName} {`,
      '  [key: string]: unknown',
      '}',
      '',
      `// ${kind} ${definition.database}.${definition.name} is emitted as unknown-key row shape in v1.`,
    ],
    findings: [],
  }
}

export function generateTypeArtifacts(
  input: GenerateTypeArtifactsInput
): GenerateTypeArtifactsOutput {
  const normalized = normalizeCodegenOptions(input.options)
  const definitions = canonicalizeDefinitions(input.definitions)
  const sortedDefinitions = definitions
    .filter((definition): definition is TableDefinition | ViewDefinition | MaterializedViewDefinition => {
      if (definition.kind === 'table') return true
      if (!normalized.includeViews) return false
      return definition.kind === 'view' || definition.kind === 'materialized_view'
    })
    .sort((a, b) => {
      if (a.database !== b.database) return a.database.localeCompare(b.database)
      return a.name.localeCompare(b.name)
    })

  const resolved = resolveTableNames(sortedDefinitions, normalized.tableNameStyle)
  const findings: CodegenFinding[] = []
  const bodyLines: string[] = []

  for (const entry of resolved) {
    const rendered =
      entry.definition.kind === 'table'
        ? renderTableInterface(entry.definition, entry.interfaceName, normalized)
        : renderViewInterface(entry.definition, entry.interfaceName)
    findings.push(...rendered.findings)
    bodyLines.push(...rendered.lines)
    bodyLines.push('')
  }

  const header = renderHeader(input.toolVersion ?? '0.1.0')
  const lines = [
    ...header,
    ...(normalized.emitZod ? ['', "import { z } from 'zod'"] : []),
    '',
    ...bodyLines,
  ]
  const content = `${lines.join('\n').trimEnd()}\n`

  return {
    content,
    outFile: normalized.outFile,
    declarationCount: resolved.length,
    findings,
  }
}

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
    lines.push(`  options?: { validate?: boolean }`)
    lines.push(`): Promise<void> {`)
    lines.push(`  const data = options?.validate ? rows.map(row => ${interfaceName}Schema.parse(row)) : rows`)
    lines.push(`  await ingestor.insert({ table: '${tableFqn}', values: data })`)
    lines.push(`}`)
  } else {
    lines.push(`export async function ${funcName}(`)
    lines.push(`  ingestor: Ingestor,`)
    lines.push(`  rows: ${interfaceName}[]`)
    lines.push(`): Promise<void> {`)
    lines.push(`  await ingestor.insert({ table: '${tableFqn}', values: rows })`)
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
  lines.push('  insert(params: { table: string; values: Record<string, unknown>[] }): Promise<void>')
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
