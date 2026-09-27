import { isKafkaEngine, normalizeKafkaEngine } from './kafka.js'
import { textExpressionFingerprint, textSQLFingerprint } from './text-index-sql.js'

/** Compare expression tokens while preserving quoted values and identifier case. */
export function sqlExpressionFingerprint(value: string): string {
  return textSQLFingerprint(textExpressionFingerprint(value))
}

export function normalizeSQLFragment(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function normalizeEngine(engine: string): string {
  if (isKafkaEngine(engine)) return normalizeKafkaEngine(engine)
  let normalized = engine.trim().replace(/^Shared/, '')
  if (!normalized.includes('(')) {
    normalized += '()'
  }
  return normalized
}
