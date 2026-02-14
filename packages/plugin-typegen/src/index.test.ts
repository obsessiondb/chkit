import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { resolveConfig, schema, table } from '@chx/core'

import {
  createTypegenPlugin,
  generateTypeArtifacts,
  mapColumnType,
  normalizeTypegenOptions,
  typegen,
} from './index'

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
const CORE_ENTRY = join(WORKSPACE_ROOT, 'packages/core/src/index.ts')

describe('@chx/plugin-typegen options', () => {
  test('exposes typegen manifest and command', () => {
    const plugin = createTypegenPlugin()

    expect(plugin.manifest.name).toBe('typegen')
    expect(plugin.manifest.apiVersion).toBe(1)
    expect(plugin.commands).toHaveLength(1)
    expect(plugin.commands[0]?.name).toBe('typegen')
  })

  test('normalizes documented option defaults', () => {
    const options = normalizeTypegenOptions()

    expect(options.outFile).toBe('./src/generated/chx-types.ts')
    expect(options.emitZod).toBe(false)
    expect(options.tableNameStyle).toBe('pascal')
    expect(options.bigintMode).toBe('string')
    expect(options.includeViews).toBe(false)
    expect(options.runOnGenerate).toBe(true)
    expect(options.failOnUnsupportedType).toBe(true)
  })

  test('creates typed inline plugin registration', () => {
    const registration = typegen({ emitZod: true })

    expect(registration.name).toBe('typegen')
    expect(registration.enabled).toBe(true)
    expect(registration.options?.emitZod).toBe(true)
    expect(registration.plugin.manifest.name).toBe('typegen')
  })
})

describe('@chx/plugin-typegen mapping', () => {
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
          path: 'app.users.payload',
          column: { name: 'payload', type: 'Array(String)' },
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
  })

  test('parameterized unknown types still fail in strict mode', () => {
    expect(() =>
      mapColumnType(
        {
          path: 'app.users.tags',
          column: { name: 'tags', type: 'Array(String)' },
        },
        { bigintMode: 'string', failOnUnsupportedType: true }
      )
    ).toThrow('Unsupported column type')
  })

  test('emits unknown and finding for unsupported type in non-strict mode', () => {
    const mapped = mapColumnType(
      {
        path: 'app.users.payload',
        column: { name: 'payload', type: 'Array(String)', nullable: true },
      },
      { bigintMode: 'string', failOnUnsupportedType: false }
    )

    expect(mapped.tsType).toBe('unknown | null')
    expect(mapped.zodType).toBe('z.unknown()')
    expect(mapped.finding?.code).toBe('typegen_unsupported_type')
  })
})

describe('@chx/plugin-typegen generation', () => {
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
      `// Generated by chx typegen plugin\n// chx-typegen-version: 0.1.0\n\nexport interface AppUsersRow {\n  id: string\n  email: string\n  created_at: string\n}\n`
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
      `// Generated by chx typegen plugin\n// chx-typegen-version: 0.1.0\n\nimport { z } from 'zod'\n\nexport interface AppUsersRow {\n  id: string\n  email: string | null\n}\n\nexport const AppUsersRowSchema = z.object({\n  id: z.string()\n  email: z.string().nullable()\n})\n\nexport type AppUsersRowInput = z.input<typeof AppUsersRowSchema>\nexport type AppUsersRowOutput = z.output<typeof AppUsersRowSchema>\n`
    )
  })
})

describe('@chx/plugin-typegen check hook', () => {
  test('onCheck reports missing and then up-to-date output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chx-typegen-plugin-'))
    const schemaPath = join(dir, 'schema.ts')
    const configPath = join(dir, 'clickhouse.config.ts')
    const outFile = join(dir, 'generated/chx-types.ts')

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

      const plugin = createTypegenPlugin({ outFile: './generated/chx-types.ts' })
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
      expect(first?.findings[0]?.code).toBe('typegen_missing_output')

      const run = plugin.commands[0]
      expect(run).toBeTruthy()
      const exitCode = await run?.run({
        args: [],
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
