import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CORE_ENTRY, getLiveEnv } from './e2e-testkit.js'

export interface E2EFixture {
  dir: string
  configPath: string
  schemaPath: string
}

export async function createFixture(input: {
  database: string
  usersTableName: string
}): Promise<E2EFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-cli-drift-e2e-'))
  const schemaPath = join(dir, 'schema.ts')
  const configPath = join(dir, 'clickhouse.config.ts')
  const outDir = join(dir, 'chkit')
  const migrationsDir = join(outDir, 'migrations')
  const metaDir = join(outDir, 'meta')

  const { clickhouseUrl, clickhouseUser, clickhousePassword } = getLiveEnv()

  await writeFile(schemaPath, renderBaseSchema(input.database, input.usersTableName), 'utf8')
  await writeFile(
    configPath,
    `export default {\n  schema: '${schemaPath}',\n  outDir: '${outDir}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${metaDir}',\n  clickhouse: {\n    url: '${clickhouseUrl}',\n    username: '${clickhouseUser}',\n    password: '${clickhousePassword}',\n    database: '${input.database}',\n  },\n}\n`,
    'utf8'
  )

  return { dir, configPath, schemaPath }
}

function renderBaseSchema(database: string, usersTableName: string): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: '${database}',\n  name: '${usersTableName}',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`
}
