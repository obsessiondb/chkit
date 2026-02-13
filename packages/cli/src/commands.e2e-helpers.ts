import { CORE_ENTRY } from './testkit.test'

export function sortedKeys(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).sort((a, b) => a.localeCompare(b))
}

export function renderScopedSchema(): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nconst events = table({\n  database: 'app',\n  name: 'events',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'source', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users, events)\n`
}
