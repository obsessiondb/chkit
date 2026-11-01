import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import {
	type ChxConfig,
	type ColumnDefinition,
	isSyntheticEphemeralDefault,
	normalizeSQLFragment,
	type ProjectionDefinition,
	parseCodec,
	type SkipIndexDefinition,
	type TableConstraintDefinition,
	parseTextIndexParams,
	parseVectorIndexArgs,
	normalizeTextIndexSQL,
} from '@chkit/core'
import { type ClickHouseSettings, ClickHouseLogLevel, createClient } from '@clickhouse/client'
import { getLogger } from '@logtape/logtape'
import { parseJsonEachRowLine, parseJsonResult } from './exact-json.js'
import { allReplicas, resolveReplicaFanout } from './replicas.js'
import {
	parseConstraintsFromCreateTableQuery,
	parseEngineFromCreateTableQuery,
	parseOrderByFromCreateTableQuery,
	parsePartitionByFromCreateTableQuery,
	parsePrimaryKeyFromCreateTableQuery,
	parseProjectionsFromCreateTableQuery,
	parseSettingsFromCreateTableQuery,
	parseTTLFromCreateTableQuery,
	parseUniqueKeyFromCreateTableQuery,
} from './create-table-parser.js'

const pkg = createRequire(import.meta.url)('../package.json') as {
	version: string
}
const CHKIT_APPLICATION_ID = `chkit/${pkg.version}`

export interface QueryStatus {
	status: 'running' | 'finished' | 'failed' | 'unknown'
	readRows?: number
	readBytes?: number
	writtenRows?: number
	writtenBytes?: number
	elapsedMs?: number
	durationMs?: number
	error?: string
}

export interface QueryStatusOptions {
	afterTime?: string
	everyReplica?: boolean
}

export type { ClickHouseSettings }

export interface ClickHouseInsertParams<T extends Record<string, unknown>> {
	table: string
	values: T[]
	/** Encode rows through a stream instead of joining an entire INSERT into one string. */
	stream?: boolean
	compressed?: boolean
	/** Per-insert settings, e.g. a stable `insert_deduplication_token`. */
	settings?: ClickHouseSettings
	/**
	 * Explicit INSERT column list as SQL identifiers (quote names that need it).
	 * Required to supply EPHEMERAL inputs: without it ClickHouse treats their
	 * keys as unknown fields and silently drops them.
	 */
	columns?: string[]
}

export interface ClickHouseJsonQueryResult<
	T extends Record<string, unknown> = Record<string, unknown>,
> {
	data: T[]
	meta: Array<{ name: string; type: string }>
	rows: number
	statistics?: {
		elapsed?: number
		rows_read?: number
		bytes_read?: number
	}
	query_id?: string
}

export type ObservableSystemTable = 'processes' | 'query_log'

export interface ClickHouseExecutor {
	command(sql: string, settings?: ClickHouseSettings): Promise<void>
	/** Rows as JSON objects. A number a double cannot hold exactly (an integer
	 *  beyond 2^53, a Decimal with more than 15 digits) arrives as a string of
	 *  its digits; the ObsessionDB console API returns every value as a string. */
	query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]>
	queryJson?<T extends Record<string, unknown>>(
		sql: string,
		settings?: ClickHouseSettings,
	): Promise<ClickHouseJsonQueryResult<T>>
	insert<T extends Record<string, unknown>>(
		params: ClickHouseInsertParams<T>,
	): Promise<void>
	listSchemaObjects(): Promise<SchemaObjectRef[]>
	listTableDetails(databases: string[]): Promise<IntrospectedTable[]>

	/** Submit a query asynchronously. ClickHouse accepts the query and processes it server-side.
	 *  Returns immediately without waiting for completion.
	 *  @param sql - The SQL to execute
	 *  @param queryId - Optional deterministic query_id (useful for resumability). Auto-generated if omitted.
	 *  @param settings - Optional ClickHouse settings sent with the query.
	 *  @returns The query_id assigned to this query. */
	submit(sql: string, queryId?: string, settings?: ClickHouseSettings): Promise<string>

	/** Check the status of a previously submitted query.
	 *  Checks system.processes first (running?), then system.query_log (finished/failed?).
	 *  On a multi-replica target (see `resolveReplicaFanout`) both are read on every replica,
	 *  because the query runs on whichever replica received it.
	 *  @param queryId - The query_id returned by submit()
	 *  @param options.afterTime - Only consider query_log entries for queries started at or after this ISO timestamp.
	 *    Useful when resubmitting with the same query_id to ignore stale entries from previous attempts.
	 *  @param options.everyReplica - Fail when a replica cannot be read instead of skipping it, so a
	 *    status other than 'running' means that no replica runs the query. Polls leave it unset and
	 *    keep going while a replica is unavailable. */
	queryStatus(queryId: string, options?: QueryStatusOptions): Promise<QueryStatus>

	/** Optional capability: FROM-clause source for cluster-aware system table polling.
	 *  Native executors return `clusterAllReplicas(...)` when `clickhouse.cluster` is set.
	 *  Remote / ObsessionDB executors may omit this and keep local `system.*` tables. */
	systemTableSource?(table: ObservableSystemTable): string

	/** Optional capability: whether the user may change settings, which a readonly = 1
	 *  user may not. Native executors look it up once, with their first read. */
	canChangeSettings?(): Promise<boolean>

	close(): Promise<void>
}

/**
 * Resolve the system table expression used for async query observation.
 * Prefers `executor.systemTableSource` when present; otherwise local `system.<table>`.
 */
export function observableSystemTable(
	executor: Pick<ClickHouseExecutor, 'systemTableSource'>,
	table: ObservableSystemTable,
): string {
	return executor.systemTableSource?.(table) ?? `system.${table}`
}

export interface SchemaObjectRef {
	kind: 'table' | 'view' | 'materialized_view' | 'dictionary'
	database: string
	name: string
}

export interface SystemTableRow {
	database: string
	name: string
	engine: string
	create_table_query?: string
	primary_key?: string
}

export interface SystemColumnRow {
	database: string
	table: string
	name: string
	type: string
	default_kind?: string
	default_expression?: string
	comment?: string
	position: number
	compression_codec?: string
}

export interface SystemSkippingIndexRow {
	database: string
	table: string
	name: string
	expr: string
	type: string
	granularity: number
}

export interface IntrospectedTable {
	database: string
	name: string
	engine?: string
	primaryKey?: string
	orderBy?: string
	uniqueKey?: string
	partitionBy?: string
	columns: ColumnDefinition[]
	settings: Record<string, string>
	indexes: SkipIndexDefinition[]
	projections: ProjectionDefinition[]
	constraints?: TableConstraintDefinition[]
	ttl?: string
}

type ClickHouseClient = ReturnType<typeof createClient>
type ClickHouseConfig = NonNullable<ChxConfig['clickhouse']>
type ClickHouseClientOptions = {
	compression?: {
		request?: boolean
		response?: boolean
	}
}

export {
	parseConstraintsFromCreateTableQuery,
	parseEngineFromCreateTableQuery,
	parseOrderByFromCreateTableQuery,
	parsePartitionByFromCreateTableQuery,
	parsePrimaryKeyFromCreateTableQuery,
	parseProjectionsFromCreateTableQuery,
	parseSettingsFromCreateTableQuery,
	parseTTLFromCreateTableQuery,
	parseUniqueKeyFromCreateTableQuery,
} from './create-table-parser.js'
export { canonicalizeSqlFragments } from './canonicalize.js'
export { listViewDetails, parseMaterializedViewTarget, type IntrospectedView } from './view-details.js'
export {
	parseCommentFromCreateDictionaryQuery,
	parseDictionaryAttributesFromCreateDictionaryQuery,
	parseDictionaryPrimaryKeyFromCreateDictionaryQuery,
	parseDictionaryRangeFromCreateDictionaryQuery,
	parseDictionarySettingsFromCreateDictionaryQuery,
	parseLayoutFromCreateDictionaryQuery,
	parseLifetimeFromCreateDictionaryQuery,
	parseSourceFromCreateDictionaryQuery,
	type ParsedDictionaryAttribute,
} from './create-dictionary-parser.js'

export function inferSchemaKindFromEngine(
	engine: string,
): SchemaObjectRef['kind'] | null {
	if (engine === 'View') return 'view'
	if (engine === 'MaterializedView') return 'materialized_view'
	if (engine === 'Dictionary') return 'dictionary'
	if (!engine) return null
	return 'table'
}

export function normalizeColumnFromSystemRow(
	row: SystemColumnRow,
): ColumnDefinition {
	const nullableMatch = row.type.match(/^Nullable\((.+)\)$/)
	const type = nullableMatch?.[1] ? nullableMatch[1] : row.type
	const nullable = Boolean(nullableMatch?.[1])
	let defaultValue: ColumnDefinition['default'] | undefined
	const defaultKind = row.default_kind
	if (defaultKind && !['DEFAULT', 'MATERIALIZED', 'ALIAS', 'EPHEMERAL'].includes(defaultKind)) {
		throw new Error(`Unsupported column default kind: ${defaultKind}`)
	}
	if (row.default_expression && defaultKind) {
		// Preserve whitespace inside SQL string literals when pulling expressions.
		defaultValue = row.default_expression.trim()
	}
	// A bare EPHEMERAL column reads back as its synthesized default.
	if (defaultKind === 'EPHEMERAL' && defaultValue !== undefined && isSyntheticEphemeralDefault(String(defaultValue))) {
		defaultValue = undefined
	}
	const codecSteps = parseCodec(row.compression_codec)
	return {
		name: row.name,
		type,
		nullable: nullable || undefined,
		default: defaultValue,
		defaultKind: defaultKind && defaultKind !== 'DEFAULT'
			? defaultKind as ColumnDefinition['defaultKind']
			: undefined,
		comment: row.comment?.trim() || undefined,
		codec: codecSteps,
	}
}

type ParsedIndexShape = SkipIndexDefinition extends infer Index
	? Index extends SkipIndexDefinition
		? Omit<Index, 'name' | 'expression' | 'granularity'>
		: never
	: never

/**
 * Maps `system.data_skipping_indices.type_full` onto the structured DSL shape.
 * A type chkit has no structured form for, or arguments that do not fit one
 * (`set` without a row limit, an unknown text parameter, a newer vector
 * similarity option), become a raw index carrying `type_full` verbatim, so pull
 * and drift never rewrite an index into a different one.
 */
function parseIndexType(value: string): ParsedIndexShape {
	const match = value.match(/^(\w+)\((.*)\)$/s)
	const baseName = match?.[1] ?? value.trim()
	const args = match?.[2]
	const raw = { type: 'raw', rawType: normalizeSQLFragment(value) } as const
	const numbers = args === undefined ? [] : splitArgs(args)
	const numeric = (count: number) => args !== undefined && numbers.length === count

	switch (baseName) {
		case 'text':
			try {
				return { type: 'text', ...parseTextIndexParams(args ?? '') }
			} catch {
				return raw
			}
		case 'vector_similarity': {
			const parsed = args === undefined ? undefined : parseVectorIndexArgs(args)
			return parsed ?? raw
		}
		case 'minmax':
			return args === undefined ? { type: 'minmax' } : raw
		case 'set':
			return numeric(1) ? { type: 'set', maxRows: numbers[0] ?? 0 } : raw
		case 'bloom_filter':
			if (args === undefined) return { type: 'bloom_filter' }
			return numeric(1) ? { type: 'bloom_filter', falsePositiveRate: numbers[0] } : raw
		case 'tokenbf_v1':
			return numeric(3)
				? { type: 'tokenbf_v1', sizeBytes: numbers[0] ?? 0, hashFunctions: numbers[1] ?? 0, randomSeed: numbers[2] ?? 0 }
				: raw
		case 'ngrambf_v1':
			return numeric(4)
				? {
						type: 'ngrambf_v1',
						ngramSize: numbers[0] ?? 0,
						sizeBytes: numbers[1] ?? 0,
						hashFunctions: numbers[2] ?? 0,
						randomSeed: numbers[3] ?? 0,
					}
				: raw
		default:
			return raw
	}
}

/** Numeric arguments, or none when any argument is not a plain number. */
function splitArgs(args: string): number[] {
	const parts = args.split(',').map((part) => part.trim())
	if (parts.some((part) => !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(part))) return []
	return parts.map(Number)
}

export function normalizeIndexFromSystemRow(
	row: SystemSkippingIndexRow,
): SkipIndexDefinition {
	const parsed = parseIndexType(row.type)
	return {
		name: row.name,
		expression: parsed.type === 'text' ? normalizeTextIndexSQL(row.expr) : normalizeSQLFragment(row.expr),
		// UInt64 arrives as a JSON string when the server quotes 64-bit integers.
		granularity: Number(row.granularity),
		...parsed,
	}
}

export function buildIntrospectedTables(
	tables: SystemTableRow[],
	columns: SystemColumnRow[],
	indexes: SystemSkippingIndexRow[],
): IntrospectedTable[] {
	const tableRows = tables.filter(
		(row) => inferSchemaKindFromEngine(row.engine) === 'table',
	)
	if (tableRows.length === 0) return []

	const columnsByTable = new Map<string, SystemColumnRow[]>()
	for (const row of columns) {
		const key = `${row.database}.${row.table}`
		const rows = columnsByTable.get(key)
		if (rows) rows.push(row)
		else columnsByTable.set(key, [row])
	}

	const indexesByTable = new Map<string, SystemSkippingIndexRow[]>()
	for (const row of indexes) {
		const key = `${row.database}.${row.table}`
		const rows = indexesByTable.get(key)
		if (rows) rows.push(row)
		else indexesByTable.set(key, [row])
	}

	return tableRows
		.map((row) => {
			const key = `${row.database}.${row.name}`
			const columnRows = (columnsByTable.get(key) ?? []).sort(
				(a, b) => a.position - b.position,
			)
			const indexRows = indexesByTable.get(key) ?? []
			return {
				database: row.database,
				name: row.name,
					engine: parseEngineFromCreateTableQuery(row.create_table_query) ?? row.engine,
				primaryKey: parsePrimaryKeyFromCreateTableQuery(row.create_table_query) ?? (row.primary_key || undefined),
				orderBy: parseOrderByFromCreateTableQuery(row.create_table_query),
				uniqueKey: parseUniqueKeyFromCreateTableQuery(row.create_table_query),
				partitionBy: parsePartitionByFromCreateTableQuery(
					row.create_table_query,
				),
				columns: columnRows.map(normalizeColumnFromSystemRow),
				settings: parseSettingsFromCreateTableQuery(row.create_table_query),
				indexes: indexRows.map(normalizeIndexFromSystemRow),
				projections: parseProjectionsFromCreateTableQuery(
					row.create_table_query,
				),
				constraints: parseConstraintsFromCreateTableQuery(row.create_table_query),
				ttl: parseTTLFromCreateTableQuery(row.create_table_query),
			}
		})
		.sort((a, b) => {
			const dbOrder = a.database.localeCompare(b.database)
			if (dbOrder !== 0) return dbOrder
			return a.name.localeCompare(b.name)
		})
}

const NETWORK_ERROR_LABELS: Record<string, string> = {
	ECONNREFUSED: 'connection refused',
	ENOTFOUND: 'host not found',
	ETIMEDOUT: 'connection timed out',
	ECONNRESET: 'connection reset',
	EHOSTUNREACH: 'host unreachable',
}

/**
 * Some @clickhouse/client and Node versions surface a network failure with the
 * reason only in the message (the `.code` is stripped), so a bare match on
 * `.code` misses them and the raw library string leaks. Recover the label from
 * the message as a fallback — e.g. a typo'd host that yields a `getaddrinfo
 * ENOTFOUND` / "Was there a typo" string.
 */
const NETWORK_MESSAGE_PATTERNS: Array<[RegExp, string]> = [
	[/ENOTFOUND|getaddrinfo|EAI_AGAIN|Was there a typo/i, 'host not found'],
	[/ECONNREFUSED/i, 'connection refused'],
	[/ETIMEDOUT|timed out/i, 'connection timed out'],
	[/ECONNRESET/i, 'connection reset'],
	[/EHOSTUNREACH/i, 'host unreachable'],
]

function networkLabelFromError(error: Error): string | undefined {
	const code =
		'code' in error ? String((error as NodeJS.ErrnoException).code ?? '') : ''
	if (code && NETWORK_ERROR_LABELS[code]) return NETWORK_ERROR_LABELS[code]
	for (const [pattern, label] of NETWORK_MESSAGE_PATTERNS) {
		if (pattern.test(error.message)) return label
	}
	return undefined
}

/**
 * ClickHouse reports a wrong/missing password with server-side error codes 194
 * (REQUIRED_PASSWORD) or 516 (AUTHENTICATION_FAILED) and a multi-line message
 * that includes Cloud reset URLs and on-disk users.d/ paths — noise that reads
 * as a leaked internal error to someone who just fat-fingered a password.
 */
function isAuthError(error: Error): boolean {
	const code = String((error as { code?: unknown }).code ?? '')
	const type = String((error as { type?: unknown }).type ?? '')
	if (code === '194' || code === '516') return true
	if (type === 'REQUIRED_PASSWORD' || type === 'AUTHENTICATION_FAILED') return true
	return /authentication failed/i.test(error.message)
}

/**
 * Builds a clean, user-facing message for a connection-time error, or returns
 * `undefined` when the error is not one we recognize (caller rethrows as-is).
 * Pure so it can be unit-tested without catching thrown errors.
 */
export function formatConnectionError(
	error: unknown,
	url: string,
	username?: string,
): string | undefined {
	if (!(error instanceof Error)) return undefined
	if (isAuthError(error)) {
		const who = username ? `user "${username}"` : 'the configured user'
		return `Authentication failed for ${who} at ${url}. Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD.`
	}
	const label = networkLabelFromError(error)
	if (label) {
		const isLocalhostDefault =
			/^https?:\/\/(localhost|127\.0\.0\.1):8123\/?$/.test(url)
		const envUnset = !process.env.CLICKHOUSE_URL
		const hint =
			isLocalhostDefault && envUnset
				? '\n  Hint: CLICKHOUSE_URL is not set — chkit fell back to the default localhost endpoint. Set CLICKHOUSE_URL to point at your ClickHouse instance.'
				: ''
		return `Could not connect to ClickHouse at ${url} (${label})${hint}`
	}
	return undefined
}

export function wrapConnectionError(error: unknown, url: string, username?: string): never {
	const message = formatConnectionError(error, url, username)
	if (message !== undefined) throw new Error(message)
	throw error
}

export function isUnknownDatabaseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	if (!('code' in error)) return false
	return String(error.code) === '81'
}

/**
 * Thrown when a ClickHouse query failed mid-flight after the server already
 * committed an HTTP 200 response by emitting progress headers. In that
 * scenario the error is reported via the `x-clickhouse-exception-code`
 * response header rather than as an HTTP error — @clickhouse/client does not
 * surface it as a thrown error, so we must detect it ourselves and throw.
 */
export class ClickHouseStreamedException extends Error {
	readonly code: string
	readonly exceptionTag: string | undefined
	readonly query_id: string | undefined
	constructor(input: {
		code: string
		exceptionTag: string | undefined
		query_id: string | undefined
		sql: string | undefined
	}) {
		const idPart = input.query_id ? ` (query_id ${input.query_id})` : ''
		const tagPart = input.exceptionTag ? `, exception_tag ${input.exceptionTag}` : ''
		const sqlPreview = input.sql
			? `\n  SQL: ${input.sql.length > 200 ? `${input.sql.slice(0, 200)}…` : input.sql}`
			: ''
		super(
			`ClickHouse query failed with exception code ${input.code}${tagPart}${idPart}.${sqlPreview}`,
		)
		this.name = 'ClickHouseStreamedException'
		this.code = input.code
		this.exceptionTag = input.exceptionTag
		this.query_id = input.query_id
	}
}

/**
 * Throws if the response carries a non-zero `x-clickhouse-exception-code`
 * header. This happens when ClickHouse sends progress headers (committing
 * HTTP 200) and then the query errors out — the error is reported in
 * headers, not by HTTP status, and @clickhouse/client does not raise it.
 */
export function assertStreamedQuerySucceeded(input: {
	response_headers: Record<string, string | string[] | undefined> | undefined
	query_id: string
	sql: string | undefined
}): void {
	const headers = input.response_headers
	if (!headers) return
	const rawCode = headers['x-clickhouse-exception-code']
	const code = Array.isArray(rawCode) ? rawCode[0] : rawCode
	if (!code || code === '0') return
	const rawTag = headers['x-clickhouse-exception-tag']
	const tag = Array.isArray(rawTag) ? rawTag[0] : rawTag
	throw new ClickHouseStreamedException({
		code,
		exceptionTag: tag,
		query_id: input.query_id,
		sql: input.sql,
	})
}

export {
	type PropagationOptions,
	waitForColumn,
	waitForColumnAbsent,
	parseExchangeTables,
	waitForDDLPropagation,
	waitForDictionary,
	waitForExchange,
	waitForTable,
	waitForTableAbsent,
	waitForView,
} from './ddl-propagation.js'
export { allReplicas, resolveReplicaFanout, type ReplicaFanout } from './replicas.js'
export { type AsyncInsertGuardOptions, type QualifiedTable, assertNoFireAndForgetAsyncInserts } from './async-insert-guard.js'
export { type InsertBarrierOptions, waitForInsertBarrier } from './insert-barrier.js'

function parseSummaryFromHeaders(
	headers: Record<string, string | string[] | undefined>,
):
	| {
			read_rows: string
			read_bytes: string
			written_rows: string
			written_bytes: string
			result_rows: string
			result_bytes: string
			elapsed_ns: string
	  }
	| undefined {
	const raw = headers['x-clickhouse-summary']
	if (!raw || typeof raw !== 'string') return undefined
	try {
		return JSON.parse(raw)
	} catch {
		return undefined
	}
}

function logProfiling(
	logger: ReturnType<typeof getLogger>,
	query: string,
	queryId: string,
	summary?: {
		read_rows: string
		read_bytes: string
		written_rows: string
		written_bytes: string
		result_rows?: string
		result_bytes?: string
		elapsed_ns: string
	},
): void {
	logger.trace('Query completed: {query}', {
		query,
		queryId,
		readRows: Number(summary?.read_rows ?? 0),
		readBytes: Number(summary?.read_bytes ?? 0),
		writtenRows: Number(summary?.written_rows ?? 0),
		writtenBytes: Number(summary?.written_bytes ?? 0),
		elapsedMs: Number(summary?.elapsed_ns ?? 0) / 1_000_000,
		resultRows: Number(summary?.result_rows ?? 0),
		resultBytes: Number(summary?.result_bytes ?? 0),
	})
}

// Sent with every request. wait_end_of_query is an HTTP parameter, not a
// setting, so a readonly = 1 user, who cannot change any setting, can send it
// too (#402).
const DEFAULT_CLICKHOUSE_SETTINGS: ClickHouseSettings = {
	wait_end_of_query: 1,
}

// Progress headers keep a long query's connection alive through proxies with
// an idle timeout (often 60 s), since wait_end_of_query holds back the body.
// Node and Bun reject a response once its headers pass ~16 KB, which the
// default 100 ms interval reaches after about 10 s, so send one every 30 s.
const PROGRESS_SETTINGS: ClickHouseSettings = {
	send_progress_in_http_headers: 1,
	http_headers_progress_interval_ms: '30000',
}

// Sent with writes only (command and insert): no asynchronous INSERTs, and
// progress headers that keep a long migration's connection alive.
const WRITE_SETTINGS: ClickHouseSettings = {
	async_insert: 0,
	...PROGRESS_SETTINGS,
}

// A readonly = 1 user cannot change any setting: ClickHouse rejects a query
// that carries one with READONLY (164). readonly = 2 allows them.
async function canChangeSettings(client: ClickHouseClient): Promise<boolean> {
	const result = await client.query({
		query: "SELECT getSetting('readonly') AS readonly",
		format: 'JSONEachRow',
	})
	const row: { readonly: string | number } = JSON.parse((await result.text()).trim())
	return Number(row.readonly) !== 1
}

// chkit emits its own clean, one-line connection errors (see wrapConnectionError).
// The built-in @clickhouse/client DefaultLogger defaults to WARN since v1.18, which
// logs the full raw server remediation blurb to stderr on any connection ERROR and
// would otherwise leak it past our clean message. Owning the level (OFF) silences it
// independent of the resolved client version, since the client does `level ?? DEFAULT`.
const SILENT_CLIENT_LOG = { level: ClickHouseLogLevel.OFF }

// @clickhouse/client uses socket.setTimeout under the hood, which is an
// inactivity timeout. For long-running INSERTs (e.g. INSERT ... SELECT FROM
// url() in the ClickBench load) ClickHouse stays silent until the operation
// completes, so any finite timeout eventually trips. 0 disables the idle
// timeout entirely — TCP keepalive still detects dead connections.
const NO_REQUEST_TIMEOUT = 0

export function createStatelessClickHouseClient(
	config: ClickHouseConfig,
	clickhouseSettings: ClickHouseSettings = DEFAULT_CLICKHOUSE_SETTINGS,
	options: ClickHouseClientOptions = {},
): ClickHouseClient {
	return createClient({
		url: config.url,
		username: config.username,
		password: config.password,
		database: config.database,
		application: CHKIT_APPLICATION_ID,
		request_timeout: NO_REQUEST_TIMEOUT,
		clickhouse_settings: clickhouseSettings,
		log: SILENT_CLIENT_LOG,
		...(options.compression ? { compression: options.compression } : {}),
	})
}

/**
 * Creates a ClickHouse client that sends one session_id with every request.
 * Use only for workflows that need session state, such as temporary tables or
 * session-level settings. ClickHouse allows only one in-flight query per HTTP
 * session, so callers must serialize all requests made through this client.
 */
export function createSessionClickHouseClient(
	config: ClickHouseConfig,
	clickhouseSettings: ClickHouseSettings = DEFAULT_CLICKHOUSE_SETTINGS,
	sessionId = crypto.randomUUID(),
	options: ClickHouseClientOptions = {},
): ClickHouseClient {
	return createClient({
		url: config.url,
		username: config.username,
		password: config.password,
		database: config.database,
		session_id: sessionId,
		application: CHKIT_APPLICATION_ID,
		request_timeout: NO_REQUEST_TIMEOUT,
		clickhouse_settings: clickhouseSettings,
		log: SILENT_CLIENT_LOG,
		...(options.compression ? { compression: options.compression } : {}),
	})
}

export function createExecutorWithClient(
	config: ClickHouseConfig,
	client: ClickHouseClient,
	options: { createCompressedClient?: () => ClickHouseClient } = {},
): ClickHouseExecutor {
	const profiler = getLogger(['chkit', 'profiling'])

	const fireAndForgetClient = createStatelessClickHouseClient(config, {
		wait_end_of_query: 0,
	})
	let compressedClient: ClickHouseClient | undefined

	// Reads add the progress settings unless the user cannot change settings,
	// looked up once per executor. A failed lookup is not cached: the database
	// may not exist yet (#370).
	let settingsChangeable: Promise<boolean> | undefined
	function settingsChangeableOnce(): Promise<boolean> {
		settingsChangeable ??= canChangeSettings(client).catch((error: unknown) => {
			settingsChangeable = undefined
			throw error
		})
		return settingsChangeable
	}
	async function readSettings(
		settings?: ClickHouseSettings,
	): Promise<ClickHouseSettings | undefined> {
		return (await settingsChangeableOnce()) ? { ...PROGRESS_SETTINGS, ...settings } : settings
	}

	return {
		async command(sql: string, settings?: ClickHouseSettings): Promise<void> {
			try {
				const result = await client.command({
					query: sql,
					http_headers: { 'X-DDL': '1' },
					clickhouse_settings: { ...WRITE_SETTINGS, ...settings },
				})
				assertStreamedQuerySucceeded({
					response_headers: result.response_headers,
					query_id: result.query_id,
					sql,
				})
				logProfiling(profiler, sql, result.query_id, result.summary)
			} catch (error) {
				if (isUnknownDatabaseError(error)) {
					const fallback = createClient({
						url: config.url,
						username: config.username,
						password: config.password,
						application: CHKIT_APPLICATION_ID,
						request_timeout: NO_REQUEST_TIMEOUT,
						clickhouse_settings: { wait_end_of_query: 1, async_insert: 0 },
						log: SILENT_CLIENT_LOG,
					})
					try {
						const fallbackResult = await fallback.command({
							query: sql,
							http_headers: { 'X-DDL': '1' },
							clickhouse_settings: { ...WRITE_SETTINGS, ...settings },
						})
						assertStreamedQuerySucceeded({
							response_headers: fallbackResult.response_headers,
							query_id: fallbackResult.query_id,
							sql,
						})
					} finally {
						await fallback.close()
					}
					return
				}
				wrapConnectionError(error, config.url, config.username)
			}
		},
		async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
			try {
				const clickhouseSettings = await readSettings(settings)
				const result = await client.query({
					query: sql,
					format: 'JSONEachRow',
					http_headers: { 'X-DDL': '1' },
					...(clickhouseSettings ? { clickhouse_settings: clickhouseSettings } : {}),
				})
				// Check headers before decoding the body. With
				// send_progress_in_http_headers=1, ClickHouse can return HTTP 200
				// then append a plain-text exception block after partial JSON
				// rows — JSON parsing would throw before we ever read the
				// exception-code header.
				assertStreamedQuerySucceeded({
					response_headers: result.response_headers,
					query_id: result.query_id,
					sql,
				})
				// The client's JSONEachRow decoder drops the final row when the
				// response ends without a newline. Decode every nonempty line,
				// without rounding 64-bit integers and Decimals (#415).
				const rows = (await result.text())
					.split('\n')
					.filter((line) => line.trim().length > 0)
					.map((line) => parseJsonEachRowLine<T>(line))
				logProfiling(
					profiler,
					sql,
					result.query_id,
					parseSummaryFromHeaders(result.response_headers),
				)
				return rows
			} catch (error) {
				wrapConnectionError(error, config.url, config.username)
			}
		},
		async queryJson<T extends Record<string, unknown>>(
			sql: string,
			settings?: ClickHouseSettings,
		): Promise<ClickHouseJsonQueryResult<T>> {
			try {
				const clickhouseSettings = await readSettings(settings)
				const result = await client.query({
					query: sql,
					format: 'JSON',
					http_headers: { 'X-DDL': '1' },
					...(clickhouseSettings ? { clickhouse_settings: clickhouseSettings } : {}),
				})
				assertStreamedQuerySucceeded({
					response_headers: result.response_headers,
					query_id: result.query_id,
					sql,
				})
				const payload = parseJsonResult<T>(await result.text())
				logProfiling(
					profiler,
					sql,
					result.query_id,
					parseSummaryFromHeaders(result.response_headers),
				)
				return {
					...payload,
					query_id: result.query_id,
				}
			} catch (error) {
				wrapConnectionError(error, config.url, config.username)
			}
		},
		async insert<T extends Record<string, unknown>>(
			params: ClickHouseInsertParams<T>,
		): Promise<void> {
			try {
				let insertClient = client
				if (params.compressed === true) {
					if (!compressedClient) {
						compressedClient =
							options.createCompressedClient?.() ??
							createStatelessClickHouseClient(
								config,
								DEFAULT_CLICKHOUSE_SETTINGS,
								{ compression: { request: true } },
							)
					}
					insertClient = compressedClient
				}
				const result = await insertClient.insert({
					table: params.table,
					values: params.stream ? Readable.from(params.values) : params.values,
					format: 'JSONEachRow',
					...(isNonEmpty(params.columns) ? { columns: params.columns } : {}),
					clickhouse_settings: { ...WRITE_SETTINGS, ...params.settings },
				})
				assertStreamedQuerySucceeded({
					response_headers: result.response_headers,
					query_id: result.query_id,
					sql: `INSERT INTO ${params.table}`,
				})
				logProfiling(
					profiler,
					`INSERT INTO ${params.table}`,
					result.query_id,
					result.summary,
				)
			} catch (error) {
				wrapConnectionError(error, config.url, config.username)
			}
		},
		async submit(sql: string, queryId?: string, settings?: ClickHouseSettings): Promise<string> {
			const id = queryId ?? crypto.randomUUID()
			// A query_id in the settings would put a second query_id on the URL, and
			// the server could run the query under an id queryStatus() never sees (#353).
			const { query_id: _ignored, ...clickhouseSettings } = settings ?? {}
			try {
				await fireAndForgetClient.command({
					query: sql,
					query_id: id,
					...(settings ? { clickhouse_settings: clickhouseSettings } : {}),
				})
			} catch (error) {
				wrapConnectionError(error, config.url, config.username)
			}
			return id
		},
		systemTableSource(table: ObservableSystemTable): string {
			// `config.cluster` is validated at resolveConfig (assertValidClusterName), so it is
			// safe to interpolate into the single-quoted clusterAllReplicas argument — same
			// contract as onClusterClause. Never guess a default name like 'cluster'.
			if (config.cluster) {
				return `clusterAllReplicas('${config.cluster}', system.${table})`
			}
			return `system.${table}`
		},
		canChangeSettings: settingsChangeableOnce,
		async queryStatus(queryId: string, options?: QueryStatusOptions): Promise<QueryStatus> {
			// Without clickhouse.cluster, a multi-replica ObsessionDB service still
			// runs the query on one replica only (#246).
			const fanout = await resolveReplicaFanout(this, config.cluster)
			const from = (table: ObservableSystemTable) =>
				fanout ? allReplicas(fanout, `system.${table}`) : observableSystemTable(this, table)
			const skipUnavailable = options?.everyReplica ? 0 : 1
			try {
				const processesFrom = from('processes')
				const running = await client.query({
					query: `SELECT read_rows, read_bytes, written_rows, written_bytes, elapsed FROM ${processesFrom} WHERE user = currentUser() AND query_id = {qid:String} SETTINGS skip_unavailable_shards = ${skipUnavailable}`,
					query_params: { qid: queryId },
					format: 'JSONEachRow',
				})
				const runningRows = await running.json<{
					read_rows: string
					read_bytes: string
					written_rows: string
					written_bytes: string
					elapsed: string
				}>()
				const [proc] = runningRows
				if (proc) {
					return {
						status: 'running',
						readRows: Number(proc.read_rows),
						readBytes: Number(proc.read_bytes),
						writtenRows: Number(proc.written_rows),
						writtenBytes: Number(proc.written_bytes),
						elapsedMs: Math.round(Number(proc.elapsed) * 1000),
					}
				}

				const afterTime = options?.afterTime ?? '1970-01-01T00:00:00Z'
				const queryLogFrom = from('query_log')
				const log = await client.query({
					query: `SELECT type, written_rows, written_bytes, query_duration_ms, exception
FROM ${queryLogFrom}
WHERE user = currentUser()
  AND query_id = {qid:String}
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND is_initial_query = 1
  AND query_start_time >= parseDateTimeBestEffort({after:String})
ORDER BY event_time DESC
LIMIT 1
SETTINGS skip_unavailable_shards = ${skipUnavailable}`,
					query_params: { qid: queryId, after: afterTime },
					format: 'JSONEachRow',
				})
				const logRows = await log.json<{
					type: string
					written_rows: string
					written_bytes: string
					query_duration_ms: string
					exception: string
				}>()

				if (logRows.length === 0) {
					return { status: 'unknown' }
				}

				const [row] = logRows
				if (!row) {
					return { status: 'unknown' }
				}
				if (row.type === 'QueryFinish') {
					return {
						status: 'finished',
						writtenRows: Number(row.written_rows),
						writtenBytes: Number(row.written_bytes),
						durationMs: Number(row.query_duration_ms),
					}
				}

				return {
					status: 'failed',
					durationMs: Number(row.query_duration_ms),
					error: row.exception,
				}
			} catch (error) {
				wrapConnectionError(error, config.url, config.username)
			}
		},
		async close(): Promise<void> {
			await Promise.all([
				client.close(),
				fireAndForgetClient.close(),
				compressedClient?.close(),
			])
		},
		async listSchemaObjects(): Promise<SchemaObjectRef[]> {
			const rows = await this.query<SystemTableRow>(
				`SELECT database, name, engine
FROM system.tables
WHERE is_temporary = 0
  AND database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
  AND name NOT LIKE '_chkit_%'`,
			)

			const out: SchemaObjectRef[] = []
			for (const row of rows) {
				const kind = inferSchemaKindFromEngine(row.engine)
				if (!kind) continue
				out.push({
					kind,
					database: row.database,
					name: row.name,
				})
			}
			return out
		},
		async listTableDetails(databases: string[]): Promise<IntrospectedTable[]> {
			if (databases.length === 0) return []

			const quotedDatabases = databases
				.map((dbName) => `'${dbName.replace(/'/g, "''")}'`)
				.join(', ')
			const tables = await this.query<SystemTableRow>(
				`SELECT database, name, engine, create_table_query, primary_key
FROM system.tables
WHERE is_temporary = 0
  AND database IN (${quotedDatabases})`,
			)
			const columns = await this.query<SystemColumnRow>(
				`SELECT database, table, name, type, default_kind, default_expression, comment, position, compression_codec
FROM system.columns
WHERE database IN (${quotedDatabases})`,
			)
			const indexes = await this.query<SystemSkippingIndexRow>(
				`SELECT database, table, name, expr, type_full AS type, granularity
FROM system.data_skipping_indices
WHERE database IN (${quotedDatabases})`,
			)

			return buildIntrospectedTables(tables, columns, indexes)
		},
	}
}

export function createClickHouseExecutor(
	config: ClickHouseConfig,
): ClickHouseExecutor {
	// Default executor is session-bound so DDL-heavy workflows run through a
	// single ClickHouse HTTP session. Do not issue concurrent queries through it.
	const sessionId = crypto.randomUUID()
	return createExecutorWithClient(
		config,
		createSessionClickHouseClient(
			config,
			DEFAULT_CLICKHOUSE_SETTINGS,
			sessionId,
		),
		{
			createCompressedClient: () =>
				createSessionClickHouseClient(
					config,
					DEFAULT_CLICKHOUSE_SETTINGS,
					sessionId,
					{ compression: { request: true } },
				),
		},
	)
}

export function createStatelessClickHouseExecutor(
	config: ClickHouseConfig,
): ClickHouseExecutor {
	return createExecutorWithClient(
		config,
		createStatelessClickHouseClient(config),
		{
			createCompressedClient: () =>
				createStatelessClickHouseClient(config, DEFAULT_CLICKHOUSE_SETTINGS, {
					compression: { request: true },
				}),
		},
	)
}

// @clickhouse/client only accepts a non-empty column list.
function isNonEmpty<T>(values: T[] | undefined): values is [T, ...T[]] {
	return values !== undefined && values.length > 0
}
