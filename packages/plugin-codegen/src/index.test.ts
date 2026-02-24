import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { resolveConfig, schema, table } from '@chkit/core'

import {
  createCodegenPlugin,
  generateTypeArtifacts,
  generateIngestArtifacts,
  mapColumnType,
  normalizeCodegenOptions,
  codegen,
} from './index'

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
const CORE_ENTRY = join(WORKSPACE_ROOT, 'packages/core/src/index.ts')

describe('@chkit/plugin-codegen options', () => {
  test('exposes codegen manifest and command', () => {
    const plugin = createCodegenPlugin()

    expect(plugin.manifest.name).toBe('codegen')
    expect(plugin.manifest.apiVersion).toBe(1)
    expect(plugin.commands).toHaveLength(1)
    expect(plugin.commands[0]?.name).toBe('codegen')
  })

  test('normalizes documented option defaults', () => {
    const options = normalizeCodegenOptions()

    expect(options.outFile).toBe('./src/generated/chkit-types.ts')
    expect(options.emitZod).toBe(false)
    expect(options.tableNameStyle).toBe('pascal')
    expect(options.bigintMode).toBe('string')
    expect(options.includeViews).toBe(false)
    expect(options.runOnGenerate).toBe(true)
    expect(options.failOnUnsupportedType).toBe(true)
    expect(options.emitIngest).toBe(false)
    expect(options.ingestOutFile).toBe('./src/generated/chkit-ingest.ts')
  })

  test('creates typed inline plugin registration', () => {
    const registration = codegen({ emitZod: true })

    expect(registration.name).toBe('codegen')
    expect(registration.enabled).toBe(true)
    expect(registration.options?.emitZod).toBe(true)
    expect(registration.plugin.manifest.name).toBe('codegen')
  })
})

describe('@chkit/plugin-codegen mapping', () => {
  test('maps primitive, nullable, and large integer types', () => {
    const numberType = mapColumnType(
      {
        path: 'app.users.count',
        column: { name: 'count', type: 'Int32' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )

    const nullableStringType = mapColumnType(
      {
        path: 'app.users.nickname',
        column: { name: 'nickname', type: 'String', nullable: true },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )

    const bigintAsBigint = mapColumnType(
      {
        path: 'app.users.id',
        column: { name: 'id', type: 'UInt64' },
      },
      { bigintMode: 'bigint', failOnUnsupportedType: true }
    )

    expect(numberType.tsType).toBe('number')
    expect(numberType.zodType).toBe('z.number()')
    expect(nullableStringType.tsType).toBe('string | null')
    expect(nullableStringType.zodType).toBe('z.string()')
    expect(bigintAsBigint.tsType).toBe('bigint')
    expect(bigintAsBigint.zodType).toBe('z.bigint()')
  })

  test('throws for unsupported type in strict mode', () => {
    expect(() =>
      mapColumnType(
        {
          path: 'app.users.state',
          column: { name: 'state', type: 'AggregateFunction(sum, UInt64)' },
        },
        { bigintMode: 'string', failOnUnsupportedType: true }
      )
    ).toThrow('Unsupported column type')
  })

  test('maps parameterized forms of known types', () => {
    const dateTimeUtc = mapColumnType(
      {
        path: 'app.events.created_at',
        column: { name: 'created_at', type: "DateTime('UTC')" },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(dateTimeUtc.tsType).toBe('string')

    const dateTime64WithPrecisionAndTz = mapColumnType(
      {
        path: 'app.events.ts',
        column: { name: 'ts', type: "DateTime64(3, 'UTC')" },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(dateTime64WithPrecisionAndTz.tsType).toBe('string')

    const dateTime64WithPrecision = mapColumnType(
      {
        path: 'app.events.ts',
        column: { name: 'ts', type: 'DateTime64(3)' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(dateTime64WithPrecision.tsType).toBe('string')

    const uuid = mapColumnType(
      {
        path: 'app.events.id',
        column: { name: 'id', type: 'UUID' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(uuid.tsType).toBe('string')

    const decimal = mapColumnType(
      {
        path: 'app.events.amount',
        column: { name: 'amount', type: 'Decimal(18, 4)' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(decimal.tsType).toBe('string')

    const enum8 = mapColumnType(
      {
        path: 'app.events.status',
        column: { name: 'status', type: "Enum8('active' = 1, 'inactive' = 2)" },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(enum8.tsType).toBe('string')
  })

  test('maps composite types', () => {
    const arrayString = mapColumnType(
      {
        path: 'app.events.tags',
        column: { name: 'tags', type: 'Array(String)' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(arrayString.tsType).toBe('string[]')
    expect(arrayString.zodType).toBe('z.array(z.string())')

    const mapStringString = mapColumnType(
      {
        path: 'app.events.metadata',
        column: { name: 'metadata', type: 'Map(String, String)' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(mapStringString.tsType).toBe('Record<string, string>')
    expect(mapStringString.zodType).toBe('z.record(z.string(), z.string())')

    const tuple = mapColumnType(
      {
        path: 'app.events.point',
        column: { name: 'point', type: 'Tuple(Float64, Float64)' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(tuple.tsType).toBe('[number, number]')
    expect(tuple.zodType).toBe('z.tuple([z.number(), z.number()])')

    const arrayNullable = mapColumnType(
      {
        path: 'app.events.values',
        column: { name: 'values', type: 'Array(Nullable(String))' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(arrayNullable.tsType).toBe('(string | null)[]')
    expect(arrayNullable.zodType).toBe('z.array(z.string().nullable())')
    expect(arrayNullable.nullable).toBe(false)
  })

  test('unwraps LowCardinality and Nullable wrappers', () => {
    const lowCardString = mapColumnType(
      {
        path: 'app.events.category',
        column: { name: 'category', type: 'LowCardinality(String)' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(lowCardString.tsType).toBe('string')
    expect(lowCardString.nullable).toBe(false)

    const lowCardNullable = mapColumnType(
      {
        path: 'app.events.region',
        column: { name: 'region', type: 'LowCardinality(Nullable(String))' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(lowCardNullable.tsType).toBe('string | null')
    expect(lowCardNullable.nullable).toBe(true)

    const nullableType = mapColumnType(
      {
        path: 'app.events.note',
        column: { name: 'note', type: 'Nullable(String)' },
      },
      { bigintMode: 'string', failOnUnsupportedType: true }
    )
    expect(nullableType.tsType).toBe('string | null')
    expect(nullableType.nullable).toBe(true)
  })

  test('emits unknown and finding for unsupported type in non-strict mode', () => {
    const mapped = mapColumnType(
      {
        path: 'app.users.state',
        column: { name: 'state', type: 'AggregateFunction(sum, UInt64)', nullable: true },
      },
      { bigintMode: 'string', failOnUnsupportedType: false }
    )

    expect(mapped.tsType).toBe('unknown | null')
    expect(mapped.zodType).toBe('z.unknown()')
    expect(mapped.finding?.code).toBe('codegen_unsupported_type')
  })
})

describe('@chkit/plugin-codegen generation', () => {
  test('generates deterministic TypeScript output', () => {
    const definitions = schema(
      table({
        database: 'app',
        name: 'users',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'email', type: 'String' },
          { name: 'created_at', type: 'DateTime' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })
    )

    const result = generateTypeArtifacts({
      definitions,
      options: {
        tableNameStyle: 'pascal',
        bigintMode: 'string',
      },
      now: new Date('2026-01-01T00:00:00.000Z'),
      toolVersion: '0.1.0',
    })

    expect(result.content).toBe(
      `// Generated by chkit codegen plugin\n// chkit-codegen-version: 0.1.0\n\nexport interface AppUsersRow {\n  id: string\n  email: string\n  created_at: string\n}\n`
    )
    expect(result.content.endsWith('\n')).toBe(true)
    expect(result.declarationCount).toBe(1)
  })

  test('header is stable across generation times', () => {
    const definitions = schema(
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })
    )

    const first = generateTypeArtifacts({
      definitions,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    const second = generateTypeArtifacts({
      definitions,
      now: new Date('2026-01-02T00:00:00.000Z'),
    })

    expect(first.content).toBe(second.content)
  })

  test('emitZod output is valid and can be imported', async () => {
    const definitions = schema(
      table({
        database: 'app',
        name: 'users',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'name', type: 'String' },
          { name: 'age', type: 'Int32' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })
    )

    const result = generateTypeArtifacts({
      definitions,
      options: { emitZod: true },
      now: new Date('2026-01-01T00:00:00.000Z'),
      toolVersion: '0.1.0',
    })

    const dir = await mkdtemp(join(tmpdir(), 'chkit-codegen-zod-'))
    const filePath = join(dir, 'types.ts')
    try {
      await symlink(join(import.meta.dir, '..', 'node_modules'), join(dir, 'node_modules'))
      await writeFile(filePath, result.content, 'utf8')
      const mod = await import(filePath)
      expect(mod.AppUsersRowSchema).toBeDefined()
      const parsed = mod.AppUsersRowSchema.parse({ id: '1', name: 'Alice', age: 30 })
      expect(parsed).toEqual({ id: '1', name: 'Alice', age: 30 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('generates deterministic TypeScript + Zod output when emitZod=true', () => {
    const definitions = schema(
      table({
        database: 'app',
        name: 'users',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'email', type: 'String', nullable: true },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })
    )

    const result = generateTypeArtifacts({
      definitions,
      options: {
        emitZod: true,
      },
      now: new Date('2026-01-01T00:00:00.000Z'),
      toolVersion: '0.1.0',
    })

    expect(result.content).toBe(
      `// Generated by chkit codegen plugin\n// chkit-codegen-version: 0.1.0\n\nimport { z } from 'zod'\n\nexport interface AppUsersRow {\n  id: string\n  email: string | null\n}\n\nexport const AppUsersRowSchema = z.object({\n  id: z.string(),\n  email: z.string().nullable(),\n})\n\nexport type AppUsersRowInput = z.input<typeof AppUsersRowSchema>\nexport type AppUsersRowOutput = z.output<typeof AppUsersRowSchema>\n`
    )
  })
})

describe('@chkit/plugin-codegen ingest generation', () => {
  test('generates ingest functions without Zod', () => {
    const definitions = schema(
      table({
        database: 'default',
        name: 'users',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'email', type: 'String' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })
    )

    const result = generateIngestArtifacts({
      definitions,
      options: {
        emitZod: false,
      },
      toolVersion: '0.1.0',
    })

    expect(result.functionCount).toBe(1)
    expect(result.content).toContain('export interface Ingestor {')
    expect(result.content).toContain('export async function ingestDefaultUsers(')
    expect(result.content).toContain("await ingestor.insert({ table: 'default.users', values: rows })")
    expect(result.content).toContain('rows: DefaultUsersRow[]')
    expect(result.content).not.toContain('validate')
    expect(result.content).not.toContain('Schema')
    expect(result.content).toContain("import type { DefaultUsersRow } from './chkit-types.js'")
  })

  test('generates ingest functions with Zod validation', () => {
    const definitions = schema(
      table({
        database: 'default',
        name: 'users',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'email', type: 'String' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })
    )

    const result = generateIngestArtifacts({
      definitions,
      options: {
        emitZod: true,
      },
      toolVersion: '0.1.0',
    })

    expect(result.functionCount).toBe(1)
    expect(result.content).toContain('export interface Ingestor {')
    expect(result.content).toContain('export async function ingestDefaultUsers(')
    expect(result.content).toContain("options?: { validate?: boolean }")
    expect(result.content).toContain('DefaultUsersRowSchema.parse(row)')
    expect(result.content).toContain("import type { DefaultUsersRow } from './chkit-types.js'")
    expect(result.content).toContain("import { DefaultUsersRowSchema } from './chkit-types.js'")
  })

  test('generates one function per table sorted by database and name', () => {
    const definitions = schema(
      table({
        database: 'app',
        name: 'users',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })
    )

    const result = generateIngestArtifacts({
      definitions,
      toolVersion: '0.1.0',
    })

    expect(result.functionCount).toBe(2)
    const eventsIndex = result.content.indexOf('ingestAppEvents')
    const usersIndex = result.content.indexOf('ingestAppUsers')
    expect(eventsIndex).toBeGreaterThan(-1)
    expect(usersIndex).toBeGreaterThan(-1)
    expect(eventsIndex).toBeLessThan(usersIndex)
  })

  test('includes codegen header in ingest output', () => {
    const definitions = schema(
      table({
        database: 'app',
        name: 'users',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      })
    )

    const result = generateIngestArtifacts({
      definitions,
      toolVersion: '0.1.0',
    })

    expect(result.content).toContain('// Generated by chkit codegen plugin')
    expect(result.content).toContain('// chkit-codegen-version: 0.1.0')
  })
})

describe('@chkit/plugin-codegen check hook', () => {
  test('onCheck reports missing and then up-to-date output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-codegen-plugin-'))
    const schemaPath = join(dir, 'schema.ts')
    const configPath = join(dir, 'clickhouse.config.ts')
    try {
      await writeFile(
        schemaPath,
        `import { schema, table } from ${JSON.stringify(pathToFileURL(CORE_ENTRY).href)}\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [{ name: 'id', type: 'UInt64' }],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users)\n`,
        'utf8'
      )
      await writeFile(
        configPath,
        `export default { schema: ${JSON.stringify(schemaPath)} }\n`,
        'utf8'
      )

      const plugin = createCodegenPlugin({ outFile: './generated/chkit-types.ts' })
      const onCheck = plugin.hooks?.onCheck
      expect(onCheck).toBeTruthy()

      const first = await onCheck?.({
        command: 'check',
        config: resolveConfig({ schema: schemaPath }),
        configPath,
        jsonMode: true,
        options: {},
      })
      expect(first?.ok).toBe(false)
      expect(first?.findings[0]?.code).toBe('codegen_missing_output')

      const run = plugin.commands[0]
      expect(run).toBeTruthy()
      const exitCode = await run?.run({
        args: [],
        flags: {},
        jsonMode: true,
        options: {},
        config: resolveConfig({ schema: schemaPath }),
        configPath,
        print() {},
      })
      expect(exitCode).toBe(0)

      const second = await onCheck?.({
        command: 'check',
        config: resolveConfig({ schema: schemaPath }),
        configPath,
        jsonMode: true,
        options: {},
      })
      expect(second?.ok).toBe(true)
      expect(second?.findings).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
