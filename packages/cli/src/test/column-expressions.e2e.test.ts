import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@clickhouse/client'
import { planDiff, table, toCreateSQL, type TableDefinition } from '@chkit/core'
import {
	normalizeColumnFromSystemRow,
	type SystemColumnRow,
} from '@chkit/clickhouse'
import { compareTableShape } from '../commands/drift/compare.js'
import { renderSchemaFile } from '../../../plugin-pull/src/render-schema.js'
import {
	generateTypeArtifacts,
	generateIngestArtifacts,
} from '../../../plugin-codegen/src/index.js'
import { createFixture, runCli } from './testkit.test.js'
import { getRequiredEnv } from './e2e-testkit.js'

test('column expressions survive create, pull, drift, inserts and ALTER on live ClickHouse', async () => {
	const env = getRequiredEnv()
	const client = createClient({
		url: env.clickhouseUrl,
		username: env.clickhouseUser,
		password: env.clickhousePassword,
		database: env.clickhouseDatabase,
	})
	const dir = await mkdtemp(join(tmpdir(), 'chkit-expression-pull-'))
	const name = `column_expr_${Date.now()}_${Math.random().toString(16).slice(2)}`
	let def = table({
		database: env.clickhouseDatabase,
		name,
		engine: 'MergeTree()',
		primaryKey: ['id'],
		orderBy: ['id'],
		columns: [
			{ name: 'id', type: 'UInt32' },
			{ name: 'ts', type: 'DateTime' },
			{ name: 'raw', type: 'String', defaultKind: 'EPHEMERAL' },
			{
				name: 'day',
				type: 'Date',
				defaultKind: 'MATERIALIZED',
				default: 'fn:toDate(ts)',
			},
			{
				name: 'label',
				type: 'String',
				defaultKind: 'ALIAS',
				default: 'fn:toString(day)',
			},
			{ name: 'size', type: 'UInt64', default: 'fn:length(raw)' },
		],
	})
	const query = async <T>(sql: string) =>
		(
			await client.query({
				query: sql,
				format: 'JSONEachRow',
				clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
			})
		).json<T>()
	const columns = async () =>
		(
			await query<SystemColumnRow>(
				`SELECT database, table, name, type, position, default_kind, default_expression FROM system.columns WHERE database='${def.database}' AND table='${name}' ORDER BY position`,
			)
		).map(normalizeColumnFromSystemRow)
	const actual = async () => ({
		columns: await columns(),
		settings: {},
		indexes: [],
		projections: [],
		engine: 'MergeTree()',
		primaryKey: 'id',
		orderBy: 'id',
	})
	const migrate = async (next: TableDefinition) => {
		const plan = planDiff([def], [next])
		for (const operation of plan.operations) {
			expect(operation.sql).not.toContain('MATERIALIZE COLUMN')
			await client.command({ query: operation.sql })
		}
		def = next
		expect(compareTableShape(def, await actual())).toBeNull()
	}
	try {
		await client.command({ query: toCreateSQL(def) })
		expect(compareTableShape(def, await actual())).toBeNull()
		const pulled = {
			...def,
			columns: (await columns()).map((column) => ({
				...column,
				default:
					typeof column.default === 'string'
						? `fn:${column.default}`
						: column.default,
			})),
		}
		const source = renderSchemaFile([pulled]).replace(
			"'@chkit/core'",
			JSON.stringify(
				new URL('../../../core/src/index.ts', import.meta.url).href,
			),
		)
		const path = join(dir, 'pulled.ts')
		await writeFile(path, source)
		const reloaded = (await import(path)).default
		expect(planDiff(reloaded, [pulled]).operations).toEqual([])
		expect(toCreateSQL(reloaded[0])).toContain('MATERIALIZED toDate(ts)')
		expect(toCreateSQL(reloaded[0])).toContain('`raw` String EPHEMERAL')

		await client.command({
			query: `INSERT INTO ${def.database}.${name} (id, ts, raw) VALUES (1, '2026-01-01 12:00:00', 'abc')`,
		})
		expect(
			await query(
				`SELECT day, label, toString(size) AS size FROM ${def.database}.${name}`,
			),
		).toEqual([{ day: '2026-01-01', label: '2026-01-01', size: '3' }])
		const generatedPath = join(dir, 'types.ts')
		await writeFile(
			generatedPath,
			generateTypeArtifacts({
				definitions: [def],
				options: { emitZod: true },
			}).content.replace("'zod'", JSON.stringify(import.meta.resolve('zod'))),
		)
		const models = await import(generatedPath)
		const readSchema =
			models[Object.keys(models).find((key) => key.endsWith('RowSchema')) ?? '']
		const explicitSchema =
			models[
				Object.keys(models).find((key) => key.endsWith('RowExplicitSchema')) ??
					''
			]
		const star = (await query(`SELECT * FROM ${def.database}.${name}`))[0]
		const full = (
			await query(
				`SELECT id, ts, day, label, size FROM ${def.database}.${name}`,
			)
		)[0]
		expect(readSchema.parse(star)).toBeDefined()
		expect(explicitSchema.safeParse(star).success).toBe(false)
		expect(explicitSchema.safeParse(full).success).toBe(true)
		await expect(
			client.command({
				query: `INSERT INTO ${def.database}.${name} (id, ts, day) VALUES (2, '2026-01-01 12:00:00', '2000-01-01')`,
			}),
		).rejects.toThrow()
		await expect(
			query(`SELECT raw FROM ${def.database}.${name}`),
		).rejects.toThrow()

		await migrate({
			...def,
			columns: def.columns.map((column) =>
				column.name === 'day'
					? { ...column, default: 'fn:addDays(toDate(ts), 1)' }
					: column,
			),
		})
		expect(
			await query(`SELECT day FROM ${def.database}.${name} WHERE id=1`),
		).toEqual([{ day: '2026-01-01' }])
		await client.command({
			query: `INSERT INTO ${def.database}.${name} (id, ts, raw) VALUES (2, '2026-01-01 12:00:00', 'abcd')`,
		})
		expect(
			await query(`SELECT day FROM ${def.database}.${name} WHERE id=2`),
		).toEqual([{ day: '2026-01-02' }])
		await migrate({
			...def,
			columns: [
				...def.columns,
				{
					name: 'copy',
					type: 'UInt32',
					defaultKind: 'MATERIALIZED',
					default: 'fn:id',
				},
			],
		})
		await migrate({
			...def,
			columns: def.columns.map((column) =>
				column.name === 'copy' ? { ...column, defaultKind: 'DEFAULT' } : column,
			),
		})
		await migrate({
			...def,
			columns: def.columns.map((column) =>
				column.name === 'copy' || column.name === 'day'
					? { name: column.name, type: column.type }
					: column,
			),
		})
		await migrate({
			...def,
			columns: def.columns.map((column) =>
				column.name === 'raw' ? { ...column, default: 'seed' } : column,
			),
		})
		await migrate({
			...def,
			columns: def.columns.map((column) =>
				column.name === 'raw' ? { ...column, default: undefined } : column,
			),
		})
	} finally {
		await client.command({
			query: `DROP TABLE IF EXISTS ${def.database}.${name} SYNC`,
		})
		await client.close()
		await rm(dir, { recursive: true, force: true })
	}
}, 30_000)

test('generated ingest helpers use insert shapes, while rows exclude ephemeral inputs', () => {
	const def = table({
		database: 'default',
		name: 'events',
		engine: 'MergeTree()',
		primaryKey: ['id'],
		orderBy: ['id'],
		columns: [
			{ name: 'id', type: 'UInt32' },
			{ name: 'raw', type: 'String', defaultKind: 'EPHEMERAL' },
			{
				name: 'computed',
				type: 'UInt32',
				defaultKind: 'MATERIALIZED',
				default: 'fn:length(raw)',
			},
			{
				name: 'label',
				type: 'String',
				defaultKind: 'ALIAS',
				default: 'fn:toString(id)',
			},
		],
	})
	const types = generateTypeArtifacts({
		definitions: [def],
		options: { emitZod: true },
	}).content
	const read = types.split('export type DefaultEventsRow = {')[1]?.split('}')[0]
	const insert = types
		.split('export type DefaultEventsRowInsert = {')[1]
		?.split('}')[0]
	expect(read).not.toContain('computed:')
	expect(read).not.toContain('label:')
	const explicit = types
		.split('export type DefaultEventsRowExplicit = {')[1]
		?.split('}')[0]
	expect(explicit).toContain('computed: number')
	expect(explicit).toContain('label: string')
	expect(explicit).not.toContain('raw:')
	expect(read).not.toContain('raw:')
	expect(insert).toContain('raw: string')
	expect(insert).not.toContain('computed:')
	expect(insert).not.toContain('label:')
	const ingest = generateIngestArtifacts({
		definitions: [def],
		options: { emitZod: true },
	}).content
	expect(ingest).toContain('rows: DefaultEventsRowInsert[]')
	expect(ingest).toContain('DefaultEventsRowInsertSchema.parse(row)')
	expect(ingest).toContain('function ingestDefaultEvents(')
})

test('manual conversion reconciles only after live verification, then generate is a no-op', async () => {
	const env = getRequiredEnv()
	const client = createClient({
		url: env.clickhouseUrl,
		username: env.clickhouseUser,
		password: env.clickhousePassword,
		database: env.clickhouseDatabase,
	})
	const name = `reconcile_expr_${Date.now()}`
	const before = table({
		database: env.clickhouseDatabase,
		name,
		engine: 'MergeTree()',
		primaryKey: ['id'],
		orderBy: ['id'],
		columns: [
			{ name: 'id', type: 'UInt32' },
			{ name: 'label', type: 'String', default: 'fn:toString(id)' },
		],
	})
	const fixture = await createFixture(
		`export default [${JSON.stringify(before)}]`,
	)
	const args = ['generate', '--config', fixture.configPath, '--json']
	try {
		await writeFile(
			fixture.configPath,
			`export default ${JSON.stringify({ schema: [fixture.schemaPath], metaDir: fixture.metaDir, migrationsDir: fixture.migrationsDir, clickhouse: { url: env.clickhouseUrl, username: env.clickhouseUser, password: env.clickhousePassword, database: env.clickhouseDatabase } })}`,
		)
		expect(runCli(args).exitCode).toBe(0)
		await client.command({ query: toCreateSQL(before) })
		const snapshotPath = join(fixture.metaDir, 'snapshot.json')
		const oldSnapshot = await readFile(snapshotPath, 'utf8')
		const after = {
			...before,
			columns: before.columns.map((col) =>
				col.name === 'label' ? { ...col, defaultKind: 'ALIAS' } : col,
			),
		}
		await writeFile(
			fixture.schemaPath,
			`export default [${JSON.stringify(after)}]`,
		)
		const reconcile = [
			...args,
			'--reconcile',
			'--table',
			`${before.database}.${name}`,
		]
		expect(runCli(reconcile).exitCode).not.toBe(0)
		expect(await readFile(snapshotPath, 'utf8')).toBe(oldSnapshot)
		await client.command({
			query: `ALTER TABLE ${before.database}.${name} DROP COLUMN label, ADD COLUMN label String ALIAS toString(id)`,
		})
		const preview = runCli([...reconcile, '--dryrun'])
		expect(preview.exitCode).toBe(0)
		expect(await readFile(snapshotPath, 'utf8')).toBe(oldSnapshot)
		const result = runCli(reconcile)
		expect(result.exitCode).toBe(0)
		expect(JSON.parse(result.stdout).verified).toBe(true)
		const next = runCli([...args, '--dryrun'])
		expect(next.exitCode).toBe(0)
		expect(JSON.parse(next.stdout).operationCount).toBe(0)
	} finally {
		await client.command({
			query: `DROP TABLE IF EXISTS ${before.database}.${name} SYNC`,
		})
		await client.close()
		await rm(fixture.dir, { recursive: true, force: true })
	}
}, 30_000)
