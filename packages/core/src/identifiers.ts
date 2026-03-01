const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``
}

export function formatIdentifier(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error('Identifier cannot be empty.')
  }
  if (SIMPLE_IDENTIFIER.test(trimmed)) return trimmed
  return quoteIdentifier(trimmed)
}

export function formatQualifiedName(database: string, name: string): string {
  return `${formatIdentifier(database)}.${formatIdentifier(name)}`
}
