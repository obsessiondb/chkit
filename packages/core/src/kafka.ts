import { splitTopLevelComma } from './key-clause.js'

export function isKafkaEngine(engine: string): boolean {
  return /^Kafka\s*(?:\(|$)/i.test(engine.trim())
}

/** Kafka has literal settings; existing engines retain their raw SQL setting contract. */
export function renderKafkaSetting(value: string | number | boolean): string {
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
  }
  return typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
}

/** Decode a ClickHouse literal from SHOW CREATE, without evaluating expressions. */
export function parseKafkaSetting(value: string): string | number | boolean {
  const trimmed = value.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    const escapes: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      a: '\u0007',
      v: '\v',
      '0': '\0',
      N: '',
      '\\': '\\',
      "'": "'",
      '"': '"',
    }
    const bytes: number[] = []
    const encoder = new TextEncoder()
    for (const token of trimmed.slice(1, -1).match(/\\x[\da-fA-F]{2}|\\[\s\S]|''|[\s\S]/gu) ?? []) {
      if (/^\\x[\da-fA-F]{2}$/.test(token)) bytes.push(Number.parseInt(token.slice(2), 16))
      else {
        const decoded =
          token === "''" ? "'" : token.startsWith('\\') ? (escapes[token[1] ?? ''] ?? token) : token
        bytes.push(...encoder.encode(decoded))
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes))
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true'
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)))
    return Number(trimmed)
  // Keep large integers lossless. String comparison handles numeric metadata.
  return trimmed
}

export function parseKafkaSettings(
  settings: Record<string, string>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, parseKafkaSetting(value)]),
  )
}

export function kafkaSettingFingerprint(value: string | number | boolean): string {
  return typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
}

export function normalizeKafkaEngine(engine: string): string {
  const args = engine.trim().match(/^Kafka\s*\(([\s\S]*)\)$/i)?.[1] ?? ''
  return `Kafka(${splitTopLevelComma(args)
    .map((arg) => {
      const parsed = parseKafkaSetting(arg)
      return arg.trim().startsWith("'") ? renderKafkaSetting(parsed) : arg.trim()
    })
    .join(', ')})`
}
