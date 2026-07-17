import {
  canonicalizeDefinitions,
  isIndexProjection,
  isRawCodec,
  type ColumnCodec,
  type ColumnCodecSpec,
  type ColumnDefinition,
  type MaterializedViewDefinition,
  type MaterializedViewRefresh,
  type ProjectionDefinition,
  type SchemaDefinition,
  type SkipIndexDefinition,
  type TableDefinition,
  type ViewDefinition,
} from '@chkit/core'

export function renderSchemaFile(definitions: SchemaDefinition[]): string {
  const canonical = canonicalizeDefinitions(definitions)
  const declarationNames = new Map<string, number>()
  const lines: string[] = [
    renderImportStatement(canonical),
    '',
    '// Pulled from live ClickHouse metadata via chkit plugin pull schema',
    '',
  ]

  const references: string[] = []

  for (const definition of canonical) {
    const variableName = resolveTableVariableName(definition.database, definition.name, declarationNames)
    references.push(variableName)
    lines.push(...renderDefinition(definition, variableName))
    lines.push('')
  }

  lines.push(`export default schema(${references.join(', ')})`)
  return `${lines.join('\n')}\n`
}

function renderImportStatement(canonical: SchemaDefinition[]): string {
  const hasTable = canonical.some((definition) => definition.kind === 'table')
  const hasView = canonical.some((definition) => definition.kind === 'view')
  const hasMaterializedView = canonical.some((definition) => definition.kind === 'materialized_view')
  const hasRawCodec = canonical.some(
    (definition) =>
      definition.kind === 'table' &&
      definition.columns.some((column) => column.codec && codecContainsRaw(column.codec))
  )
  const imports = ['schema']
  if (hasTable) imports.push('table')
  if (hasView) imports.push('view')
  if (hasMaterializedView) imports.push('materializedView')
  if (hasRawCodec) imports.push('codec')
  return `import { ${imports.join(', ')} } from '@chkit/core'`
}

function renderDefinition(definition: SchemaDefinition, variableName: string): string[] {
  switch (definition.kind) {
    case 'table':
      return renderTableDefinition(definition, variableName)
    case 'view':
      return renderViewDefinition(definition, variableName)
    default:
      return renderMaterializedViewDefinition(definition, variableName)
  }
}

function renderTableDefinition(definition: TableDefinition, variableName: string): string[] {
  const lines = renderDeclarationHeader('table', variableName, definition.database, definition.name)
  lines.push(`  engine: ${renderString(definition.engine)},`)
  lines.push('  columns: [')
  for (const column of definition.columns) {
    lines.push(`    ${renderColumn(column)},`)
  }
  lines.push('  ],')
  lines.push(`  primaryKey: ${renderStringArray(definition.primaryKey)},`)
  lines.push(`  orderBy: ${renderStringArray(definition.orderBy)},`)
  if (definition.uniqueKey && definition.uniqueKey.length > 0) {
    lines.push(`  uniqueKey: ${renderStringArray(definition.uniqueKey)},`)
  }
  if (definition.partitionBy) {
    lines.push(`  partitionBy: ${renderString(definition.partitionBy)},`)
  }
  if (definition.ttl) {
    lines.push(`  ttl: ${renderString(definition.ttl)},`)
  }
  if (definition.settings && Object.keys(definition.settings).length > 0) {
    lines.push(...renderSettingsLines(definition.settings, '  '))
  }
  if (definition.indexes && definition.indexes.length > 0) {
    lines.push(...renderIndexLines(definition.indexes))
  }
  if (definition.projections && definition.projections.length > 0) {
    lines.push(...renderProjectionLines(definition.projections))
  }
  lines.push('})')
  return lines
}

function renderViewDefinition(definition: ViewDefinition, variableName: string): string[] {
  const lines = renderDeclarationHeader('view', variableName, definition.database, definition.name)
  lines.push(`  as: ${renderString(definition.as)},`)
  lines.push('})')
  return lines
}

function renderMaterializedViewDefinition(
  definition: MaterializedViewDefinition,
  variableName: string
): string[] {
  const lines = renderDeclarationHeader('materializedView', variableName, definition.database, definition.name)
  lines.push(`  to: { database: ${renderString(definition.to.database)}, name: ${renderString(definition.to.name)} },`)
  if (definition.refresh) {
    lines.push(...renderRefreshLines(definition.refresh))
  }
  lines.push(`  as: ${renderString(definition.as)},`)
  lines.push('})')
  return lines
}

function renderDeclarationHeader(
  factory: string,
  variableName: string,
  database: string,
  name: string
): string[] {
  return [
    `const ${variableName} = ${factory}({`,
    `  database: ${renderString(database)},`,
    `  name: ${renderString(name)},`,
  ]
}

function renderColumn(column: ColumnDefinition): string {
  const parts: string[] = [
    `name: ${renderString(column.name)}`,
    `type: ${renderString(column.type)}`,
  ]
  if (column.nullable) parts.push('nullable: true')
  if (column.default !== undefined) parts.push(`default: ${renderLiteral(column.default)}`)
  if (column.comment) parts.push(`comment: ${renderString(column.comment)}`)
  if (column.codec) parts.push(`codec: ${renderCodecSource(column.codec)}`)
  return `{ ${parts.join(', ')} }`
}

function renderIndexLines(indexes: SkipIndexDefinition[]): string[] {
  const lines: string[] = ['  indexes: [']
  for (const index of indexes) {
    lines.push(`    ${renderIndex(index)},`)
  }
  lines.push('  ],')
  return lines
}

function renderIndex(index: SkipIndexDefinition): string {
  const parts = [
    `name: ${renderString(index.name)}`,
    `expression: ${renderString(index.expression)}`,
    `type: ${renderString(index.type)}`,
  ]
  switch (index.type) {
    case 'minmax':
      break
    case 'set':
      parts.push(`maxRows: ${index.maxRows}`)
      break
    case 'bloom_filter':
      if (index.falsePositiveRate !== undefined) {
        parts.push(`falsePositiveRate: ${index.falsePositiveRate}`)
      }
      break
    case 'tokenbf_v1':
      parts.push(
        `sizeBytes: ${index.sizeBytes}`,
        `hashFunctions: ${index.hashFunctions}`,
        `randomSeed: ${index.randomSeed}`
      )
      break
    case 'ngrambf_v1':
      parts.push(
        `ngramSize: ${index.ngramSize}`,
        `sizeBytes: ${index.sizeBytes}`,
        `hashFunctions: ${index.hashFunctions}`,
        `randomSeed: ${index.randomSeed}`
      )
      break
  }
  parts.push(`granularity: ${index.granularity}`)
  return `{ ${parts.join(', ')} }`
}

function renderProjectionLines(projections: ProjectionDefinition[]): string[] {
  const lines: string[] = ['  projections: [']
  for (const projection of projections) {
    const fields = isIndexProjection(projection)
      ? `index: ${renderString(projection.index)}, type: ${renderString(projection.type)}`
      : `query: ${renderString(projection.query)}`
    lines.push(`    { name: ${renderString(projection.name)}, ${fields} },`)
  }
  lines.push('  ],')
  return lines
}

function renderRefreshLines(refresh: MaterializedViewRefresh): string[] {
  const lines: string[] = []
  lines.push('  refresh: {')
  if (refresh.every) lines.push(`    every: ${renderString(refresh.every)},`)
  if (refresh.after) lines.push(`    after: ${renderString(refresh.after)},`)
  if (refresh.offset) lines.push(`    offset: ${renderString(refresh.offset)},`)
  if (refresh.randomize) lines.push(`    randomize: ${renderString(refresh.randomize)},`)
  if (refresh.dependsOn && refresh.dependsOn.length > 0) {
    lines.push('    dependsOn: [')
    for (const dep of refresh.dependsOn) {
      lines.push(`      { database: ${renderString(dep.database)}, name: ${renderString(dep.name)} },`)
    }
    lines.push('    ],')
  }
  if (refresh.settings && Object.keys(refresh.settings).length > 0) {
    lines.push(...renderSettingsLines(refresh.settings, '    '))
  }
  if (refresh.append) lines.push('    append: true,')
  if (refresh.empty) lines.push('    empty: true,')
  lines.push('  },')
  return lines
}

function renderSettingsLines(
  settings: Record<string, string | number | boolean>,
  indent: string
): string[] {
  const lines: string[] = [`${indent}settings: {`]
  for (const key of Object.keys(settings).sort()) {
    const value = settings[key]
    if (value === undefined) continue
    lines.push(`${indent}  ${renderKey(key)}: ${renderLiteral(value)},`)
  }
  lines.push(`${indent}},`)
  return lines
}

function resolveTableVariableName(
  database: string,
  name: string,
  counts: Map<string, number>
): string {
  const base = sanitizeIdentifier(`${database}_${name}`)
  const current = counts.get(base) ?? 0
  const next = current + 1
  counts.set(base, next)
  return next === 1 ? base : `${base}_${next}`
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (sanitized.length === 0) return 'table_ref'
  if (/^[0-9]/.test(sanitized)) return `table_${sanitized}`
  return sanitized
}

function renderString(value: string): string {
  return JSON.stringify(value)
}

function renderStringArray(values: string[]): string {
  return `[${values.map((value) => renderString(value)).join(', ')}]`
}

function renderLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return renderString(value)
  return String(value)
}

function renderKey(value: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(value)) return value
  return renderString(value)
}

function codecContainsRaw(spec: ColumnCodecSpec): boolean {
  const steps = Array.isArray(spec) ? spec : [spec]
  return steps.some((step) => isRawCodec(step))
}

function renderCodecStepSource(step: ColumnCodec): string {
  if (isRawCodec(step)) return `codec.raw(${renderString(step.expression)})`
  const parts: string[] = [`kind: ${renderString(step.kind)}`]
  if (step.kind === 'ZSTD' || step.kind === 'LZ4HC') {
    if (step.level !== undefined) parts.push(`level: ${step.level}`)
  } else if (step.kind === 'Delta' || step.kind === 'DoubleDelta' || step.kind === 'Gorilla') {
    if (step.size !== undefined) parts.push(`size: ${step.size}`)
  } else if (step.kind === 'FPC') {
    parts.push(`level: ${step.level}`)
    parts.push(`floatSize: ${step.floatSize}`)
  }
  return `{ ${parts.join(', ')} }`
}

function renderCodecSource(spec: ColumnCodecSpec): string {
  const steps = Array.isArray(spec) ? spec : [spec]
  const [first] = steps
  if (steps.length === 1 && first) return renderCodecStepSource(first)
  return `[${steps.map(renderCodecStepSource).join(', ')}]`
}
