export interface MigrationMetadata {
  log?: string
}

const KNOWN_KEYS = new Set<keyof MigrationMetadata>(['log'])

const META_LINE = /^--\s*([a-z][a-z0-9-]*)\s*:\s*(.+)$/i

export function extractMigrationMetadata(sql: string): MigrationMetadata {
  const meta: MigrationMetadata = {}
  for (const rawLine of sql.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (!line.startsWith('--')) break
    const match = line.match(META_LINE)
    if (!match) continue
    const key = match[1]?.toLowerCase()
    const value = match[2]?.trim()
    if (!key || !value) continue
    if (!isKnownKey(key)) continue
    if (meta[key] !== undefined) continue
    meta[key] = value
  }
  return meta
}

function isKnownKey(key: string): key is keyof MigrationMetadata {
  return KNOWN_KEYS.has(key as keyof MigrationMetadata)
}
