export function normalizeSQLFragment(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function normalizeEngine(engine: string): string {
  let normalized = engine.trim().replace(/^Shared/, '')
  if (!normalized.includes('(')) {
    normalized += '()'
  }
  return normalized
}
