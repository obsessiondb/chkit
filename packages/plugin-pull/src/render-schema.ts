import { canonicalizeDefinitions, type SchemaDefinition } from '@chkit/core'

export function renderSchemaFile(definitions: SchemaDefinition[]): string {
  const canonical = canonicalizeDefinitions(definitions)
  const declarationNames = new Map<string, number>()
  const hasTable = canonical.some((definition) => definition.kind === 'table')
  const hasView = canonical.some((definition) => definition.kind === 'view')
  const hasMaterializedView = canonical.some((definition) => definition.kind === 'materialized_view')
  const imports = ['schema']
  if (hasTable) imports.push('table')
  if (hasView) imports.push('view')
  if (hasMaterializedView) imports.push('materializedView')
  const lines: string[] = [
    `import { ${imports.join(', ')} } from '@chkit/core'`,
    '',
    '// Pulled from live ClickHouse metadata via chkit plugin pull schema',
    '',
  ]

  const references: string[] = []

  for (const definition of canonical) {
    const variableName = resolveTableVariableName(definition.database, definition.name, declarationNames)
    references.push(variableName)

    if (definition.kind === 'table') {
      lines.push(`const ${variableName} = table({`)
      lines.push(`  database: ${renderString(definition.database)},`)
      lines.push(`  name: ${renderString(definition.name)},`)
      lines.push(`  engine: ${renderString(definition.engine)},`)
      lines.push('  columns: [')

      for (const column of definition.columns) {
        const parts: string[] = [
          `name: ${renderString(column.name)}`,
          `type: ${renderString(column.type)}`,
        ]
        if (column.nullable) parts.push('nullable: true')
        if (column.default !== undefined) parts.push(`default: ${renderLiteral(column.default)}`)
        if (column.comment) parts.push(`comment: ${renderString(column.comment)}`)
        lines.push(`    { ${parts.join(', ')} },`)
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
        lines.push('  settings: {')
        for (const key of Object.keys(definition.settings).sort()) {
          const value = definition.settings[key]
          if (value === undefined) continue
          lines.push(`    ${renderKey(key)}: ${renderLiteral(value)},`)
        }
        lines.push('  },')
      }
      if (definition.indexes && definition.indexes.length > 0) {
        lines.push('  indexes: [')
        for (const index of definition.indexes) {
          lines.push(
            `    { name: ${renderString(index.name)}, expression: ${renderString(index.expression)}, type: ${renderString(index.type)}, granularity: ${index.granularity} },`
          )
        }
        lines.push('  ],')
      }
      if (definition.projections && definition.projections.length > 0) {
        lines.push('  projections: [')
        for (const projection of definition.projections) {
          lines.push(
            `    { name: ${renderString(projection.name)}, query: ${renderString(projection.query)} },`
          )
        }
        lines.push('  ],')
      }
      lines.push('})')
    } else if (definition.kind === 'view') {
      lines.push(`const ${variableName} = view({`)
      lines.push(`  database: ${renderString(definition.database)},`)
      lines.push(`  name: ${renderString(definition.name)},`)
      lines.push(`  as: ${renderString(definition.as)},`)
      lines.push('})')
    } else {
      lines.push(`const ${variableName} = materializedView({`)
      lines.push(`  database: ${renderString(definition.database)},`)
      lines.push(`  name: ${renderString(definition.name)},`)
      lines.push(`  to: { database: ${renderString(definition.to.database)}, name: ${renderString(definition.to.name)} },`)
      lines.push(`  as: ${renderString(definition.as)},`)
      lines.push('})')
    }
    lines.push('')
  }

  lines.push(`export default schema(${references.join(', ')})`)
  return `${lines.join('\n')}\n`
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
