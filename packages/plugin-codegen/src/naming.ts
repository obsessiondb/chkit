import type { MaterializedViewDefinition, TableDefinition, ViewDefinition } from '@chkit/core'

import type { CodegenPluginOptions, ResolvedTableName } from './types.js'

function toWords(input: string): string[] {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function pascalCase(input: string): string {
  const words = toWords(input)
  if (words.length === 0) return 'Item'
  return words.map((part) => part[0]?.toUpperCase() + part.slice(1)).join('')
}

function camelCase(input: string): string {
  const words = toWords(input)
  if (words.length === 0) return 'item'
  const [head, ...tail] = words
  return `${head?.toLowerCase() ?? 'item'}${tail
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join('')}`
}

function rawCase(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return sanitized.length > 0 ? sanitized : 'item'
}

export function isValidIdentifier(input: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input)
}

export function renderPropertyName(name: string): string {
  if (isValidIdentifier(name)) return name
  return JSON.stringify(name)
}

function baseRowTypeName(
  definition: Pick<TableDefinition | ViewDefinition | MaterializedViewDefinition, 'database' | 'name'>,
  style: Required<CodegenPluginOptions>['tableNameStyle']
): string {
  const combined = `${definition.database}_${definition.name}`
  if (style === 'raw') {
    const candidate = `${rawCase(combined)}_row`
    return isValidIdentifier(candidate) ? candidate : `_${candidate}`
  }
  if (style === 'camel') {
    return `${camelCase(combined)}Row`
  }
  return `${pascalCase(combined)}Row`
}

export function resolveTableNames(
  definitions: Array<TableDefinition | ViewDefinition | MaterializedViewDefinition>,
  style: Required<CodegenPluginOptions>['tableNameStyle']
): ResolvedTableName[] {
  const baseNames = definitions.map((definition) => ({
    definition,
    base: baseRowTypeName(definition, style),
  }))
  const counts = new Map<string, number>()

  return baseNames.map((item) => {
    const seen = counts.get(item.base) ?? 0
    const nextSeen = seen + 1
    counts.set(item.base, nextSeen)
    return {
      definition: item.definition,
      interfaceName: nextSeen === 1 ? item.base : `${item.base}_${nextSeen}`,
    }
  })
}
