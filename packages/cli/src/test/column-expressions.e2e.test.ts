import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@clickhouse/client'
import {
	planDiff,
	table,
	toCreateSQL,
	validateDefinitions,
	type TableDefinition,
} from '@chkit/core'
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
import { buildBackfillPlan } from '../../../plugin-backfill/src/planner.js'
import { PlanSchema } from '../../../plugin-backfill/src/options.js'
import {
	createLiveExecutor,
	createPrefix,
	getRequiredEnv,
	pollUntil,
	quoteIdent,
} from './e2e-testkit.js'

test('column expressions survive create, pull, drift, inserts and ALTER on live ClickHouse', async () => {
	const env = getRequiredEnv()
	// One session pins every request to one replica, so an INSERT after an ALTER
	// sees the expression the shape poll just confirmed (ObsessionDB replicas lag).
	// Requests must stay sequential: a session runs one query at a time.
	const client = createClient({
		url: env.clickhouseUrl,
		username: env.clickhouseUser,
		password: env.clickhousePassword,
		database: env.clickhouseDatabase,
		session_id: crypto.randomUUID(),
	})
	const dir = await mkdtemp(join(tmpdir(), 'chkit-expression-pull-'))
	const name = `column_expr_${Date.now()}_${Math.random().toString(16).slice(2)}`
	const keyed = `${name}_keyed`
	const coded = `${name}_code`
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
	// Inserted rows can reach replicas at different times on managed ClickHouse
	// (e.g. ObsessionDB): re-read until the expected rows are visible.
	const settledRows = <T>(sql: string, count: number) =>
		pollUntil(() => query<T>(sql), (rows) => rows.length === count)
	const columns = async () =>
		(
			await query<SystemColumnRow>(
				`SELECT database, table, name, type, position, default_kind, default_expression FROM system.columns WHERE database='${def.database}' AND table='${def.name}' ORDER BY position`,
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
	// DDL is eventually consistent on managed ClickHouse (e.g. ObsessionDB): re-read
	// system.columns until it reflects the definition before comparing.
	const settledShape = () =>
		pollUntil(actual, (shape) => compareTableShape(def, shape) === null)
	const migrate = async (next: TableDefinition) => {
		const plan = planDiff([def], [next])
		for (const operation of plan.operations) {
			expect(operation.sql).not.toContain('MATERIALIZE COLUMN')
			await client.command({ query: operation.sql })
		}
		def = next
		expect(compareTableShape(def, await settledShape())).toBeNull()
	}
	try {
		await client.command({ query: toCreateSQL(def) })
		expect(compareTableShape(def, await settledShape())).toBeNull()
		const backfill = (target: string) =>
			buildBackfillPlan({
				opts: PlanSchema.parse({ target: `${def.database}.${target}` }),
				configPath: join(dir, 'config.ts'),
				config: { metaDir: join(dir, 'meta'), schema: [join(dir, 'missing.ts')] },
				clickhouseQuery: query,
			})
		await expect(backfill(name)).rejects.toThrow('cannot reconstruct EPHEMERAL inputs')
		await expect(backfill(`${name}_missing`)).rejects.toThrow('does not exist or is not visible yet')
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
			await settledRows(
				`SELECT day, label, toString(size) AS size FROM ${def.database}.${name}`,
				1,
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
		const star = (await settledRows(`SELECT * FROM ${def.database}.${name}`, 1))[0]
		const full = (
			await settledRows(
				`SELECT id, ts, day, label, size FROM ${def.database}.${name}`,
				1,
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

		await migrate({
			...def,
			columns: def.columns.map((column) =>
				column.name === 'day'
					? { ...column, default: 'fn:addDays(toDate(ts), 1)' }
					: column,
			),
		})
		expect(
			await settledRows(`SELECT day FROM ${def.database}.${name} WHERE id=1`, 1),
		).toEqual([{ day: '2026-01-01' }])
		await client.command({
			query: `INSERT INTO ${def.database}.${name} (id, ts, raw) VALUES (2, '2026-01-01 12:00:00', 'abcd')`,
		})
		expect(
			await settledRows(`SELECT day FROM ${def.database}.${name} WHERE id=2`, 1),
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
		// In one ALTER, ClickHouse casts the retained 'abc' to UInt64 before the REMOVE.
		// A fresh single-part table: merging older parts that lack `code` would store 'abc'.
		def = table({
			...def,
			name: coded,
			columns: [{ name: 'id', type: 'UInt32' }, { name: 'code', type: 'String', default: 'abc' }],
		})
		await client.command({ query: toCreateSQL(def) })
		expect(compareTableShape(def, await settledShape())).toBeNull()
		await client.command({
			query: `INSERT INTO ${def.database}.${coded} (id, code) VALUES (1, '42')`,
		})
		await migrate({ ...def, columns: [{ name: 'id', type: 'UInt32' }, { name: 'code', type: 'UInt64' }] })
		expect(
			await query(`SELECT toString(code) AS code FROM ${def.database}.${coded}`),
		).toEqual([{ code: '42' }])

		const keyedSQL = (kind: string) =>
			`CREATE TABLE ${def.database}.${keyed} (id UInt32, k UInt32 ${kind} id) ENGINE = MergeTree ORDER BY (id, k)`
		const aliasKeyed = table({
			database: def.database,
			name: keyed,
			engine: 'MergeTree()',
			primaryKey: ['id'],
			orderBy: ['id', 'k'],
			columns: [
				{ name: 'id', type: 'UInt32' },
				{ name: 'k', type: 'UInt32', defaultKind: 'ALIAS', default: 'fn:id' },
			],
		})
		expect(validateDefinitions([aliasKeyed]).map((issue) => issue.code)).toEqual([
			'column_kind_not_stored',
		])
		await expect(client.command({ query: keyedSQL('ALIAS') })).rejects.toMatchObject({
			type: 'UNKNOWN_IDENTIFIER',
		})
		await client.command({ query: keyedSQL('MATERIALIZED') })
	} finally {
		for (const tableName of [name, coded, keyed]) {
			await client.command({
				query: `DROP TABLE IF EXISTS ${def.database}.${tableName} SYNC`,
			})
		}
		await client.close()
		await rm(dir, { recursive: true, force: true })
	}
}, 120_000)

test('hand-written heredoc defaults and alias-typed EPHEMERAL columns show no drift', async () => {
	const env = getRequiredEnv()
	const executor = createLiveExecutor(env)
	const def = table({
		database: env.clickhouseDatabase,
		name: `${createPrefix('expr_drift')}events`,
		engine: 'MergeTree()',
		primaryKey: ['id'],
		orderBy: ['id'],
		columns: [
			{ name: 'id', type: 'UInt32' },
			{ name: 'msg', type: 'String', default: "fn:$$it's$$" },
			{ name: 'wrapped', type: 'String', default: "fn:concat($$(x$$, 'y')" },
			{ name: 'big', type: 'Int64', defaultKind: 'EPHEMERAL' },
			{ name: 'dec', type: 'Decimal(9, 2)', defaultKind: 'EPHEMERAL' },
			{ name: 'opt', type: 'Int64', nullable: true, defaultKind: 'EPHEMERAL' },
			{ name: 'explicit', type: 'String', defaultKind: 'EPHEMERAL', default: "fn:defaultValueOfTypeName('String')" },
		],
	})
	const fqn = `${quoteIdent(def.database)}.${quoteIdent(def.name)}`
	try {
		// ClickHouse stores heredocs as quoted literals and canonicalizes alias types,
		// but keeps the written spelling in the synthesized EPHEMERAL default.
		await executor.command(
			`CREATE TABLE ${fqn} (id UInt32, msg String DEFAULT $$it's$$, wrapped String DEFAULT concat($$(x$$, 'y'), big BIGINT EPHEMERAL, dec Decimal32(2) EPHEMERAL, opt Nullable(BIGINT) EPHEMERAL, explicit String EPHEMERAL defaultValueOfTypeName('String')) ENGINE = MergeTree ORDER BY id`,
		)
		const shape = await pollUntil(
			async () => (await executor.listTableDetails([def.database])).find((item) => item.name === def.name),
			(item) => item?.columns.length === def.columns.length,
		)
		expect(shape && compareTableShape(def, shape)).toBeNull()
	} finally {
		await executor.command(`DROP TABLE IF EXISTS ${fqn}`)
		await executor.close()
	}
}, 60_000)

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
