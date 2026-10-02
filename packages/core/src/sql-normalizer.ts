import { isKafkaEngine, normalizeKafkaEngine } from './kafka.js'
import { textExpressionFingerprint, textSQLFingerprint } from './text-index-sql.js'

const SYNTHETIC_EPHEMERAL_DEFAULT = /^defaultValueOfTypeName\s*\(\s*'(?:[^'\\]|\\.|'')*'\s*\)$/s

/**
 * Compare expression tokens while preserving quoted values and identifier case.
 * SQL the lexer cannot read (e.g. an unterminated quote) falls back to whitespace
 * normalization, encoded as a JSON string so it never equals a token list.
 */
export function sqlExpressionFingerprint(value: string): string {
  try {
    return textSQLFingerprint(textExpressionFingerprint(value))
  } catch {
    return JSON.stringify(normalizeSQLFragment(value))
  }
}

/**
 * Whether `expression` is the default ClickHouse stores for a bare EPHEMERAL
 * column. ClickHouse synthesizes defaultValueOfTypeName('<type as written>');
 * the literal keeps alias spellings (BIGINT, TEXT) that system.columns.type
 * canonicalizes, so any single string literal counts.
 */
export function isSyntheticEphemeralDefault(expression: string): boolean {
  return SYNTHETIC_EPHEMERAL_DEFAULT.test(expression.trim())
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
