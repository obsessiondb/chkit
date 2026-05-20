import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	type ClickHouseExecutor,
	createClickHouseExecutor,
} from '@chkit/clickhouse'
import {
	type ChxLegacyPluginRegistration,
	type ChxPluginRegistration,
	canonicalizeDefinitions,
	type ResolvedChxConfig,
} from '@chkit/core'

import type {
	ChxOnBeforePluginCommandContext,
	ChxOnBeforePluginCommandResult,
	ChxOnCheckResult,
	ChxPlugin,
	LoadedPlugin,
	PluginContext,
	PluginRuntime,
	TableScope,
} from '../plugins.js'
import { isInlinePluginRegistration } from '../plugins.js'
import { debug, isDebugEnabled } from './debug.js'

const UNFILTERED_TABLE_SCOPE: TableScope = {
	enabled: false,
	matchedTables: [],
	matchCount: 0,
}

function parseCliMajor(version: string): number {
	const major = Number(version.split('.')[0] ?? Number.NaN)
	if (!Number.isInteger(major) || major < 0) {
		throw new Error(`Invalid CLI version "${version}" while loading plugins.`)
	}
	return major
}

function normalizePluginRegistration(entry: ChxPluginRegistration): {
	kind: 'legacy' | 'inline'
	resolvePath: string
	inlinePlugin?: ChxPlugin
	nameHint?: string
	enabled: boolean
	options: Record<string, unknown>
} {
	if (typeof entry === 'string') {
		return {
			kind: 'legacy',
			resolvePath: entry,
			enabled: true,
			options: {},
		}
	}

	if (isInlinePluginRegistration(entry)) {
		return {
			kind: 'inline',
			resolvePath: '',
			inlinePlugin: entry.plugin,
			nameHint: entry.name,
			enabled: entry.enabled !== false,
			options: entry.options ?? {},
		}
	}

	const legacy = entry as ChxLegacyPluginRegistration
	return {
		kind: 'legacy',
		resolvePath: legacy.resolve,
		nameHint: legacy.name,
		enabled: legacy.enabled !== false,
		options: legacy.options ?? {},
	}
}

function wrapExecutorWithDebug(
	executor: ClickHouseExecutor,
): ClickHouseExecutor {
	if (!isDebugEnabled()) return executor
	const queryJson = executor.queryJson?.bind(executor)

	return {
		async command(sql: string): Promise<void> {
			debug(
				'clickhouse',
				`command: ${sql.slice(0, 200)}${sql.length > 200 ? '...' : ''}`,
			)
			const start = performance.now()
			try {
				await executor.command(sql)
				debug(
					'clickhouse',
					`command OK (${Math.round(performance.now() - start)}ms)`,
				)
			} catch (error) {
				debug(
					'clickhouse',
					`command FAILED (${Math.round(performance.now() - start)}ms)`,
					error instanceof Error ? error.message : error,
				)
				throw error
			}
		},
		async query<T>(sql: string): Promise<T[]> {
			debug(
				'clickhouse',
				`query: ${sql.slice(0, 200)}${sql.length > 200 ? '...' : ''}`,
			)
			const start = performance.now()
			try {
				const rows = await executor.query<T>(sql)
				debug(
					'clickhouse',
					`query OK — ${rows.length} rows (${Math.round(performance.now() - start)}ms)`,
				)
				return rows
			} catch (error) {
				debug(
					'clickhouse',
					`query FAILED (${Math.round(performance.now() - start)}ms)`,
					error instanceof Error ? error.message : error,
				)
				throw error
			}
		},
		...(queryJson
			? {
					async queryJson<T extends Record<string, unknown>>(sql: string) {
						debug(
							'clickhouse',
							`queryJson: ${sql.slice(0, 200)}${sql.length > 200 ? '...' : ''}`,
						)
						const start = performance.now()
						try {
							const payload = await queryJson<T>(sql)
							debug(
								'clickhouse',
								`queryJson OK — ${payload.rows} rows (${Math.round(performance.now() - start)}ms)`,
							)
							return payload
						} catch (error) {
							debug(
								'clickhouse',
								`queryJson FAILED (${Math.round(performance.now() - start)}ms)`,
								error instanceof Error ? error.message : error,
							)
							throw error
						}
					},
				}
			: {}),
		async insert<T extends Record<string, unknown>>(params: {
			table: string
			values: T[]
			compressed?: boolean
		}): Promise<void> {
			debug(
				'clickhouse',
				`insert into ${params.table} — ${params.values.length} rows`,
			)
			const start = performance.now()
			try {
				await executor.insert(params)
				debug(
					'clickhouse',
					`insert OK (${Math.round(performance.now() - start)}ms)`,
				)
			} catch (error) {
				debug(
					'clickhouse',
					`insert FAILED (${Math.round(performance.now() - start)}ms)`,
					error instanceof Error ? error.message : error,
				)
				throw error
			}
		},
		async submit(sql: string, queryId?: string): Promise<string> {
			debug(
				'clickhouse',
				`submit${queryId ? ` (id: ${queryId})` : ''}: ${sql.slice(0, 200)}${sql.length > 200 ? '...' : ''}`,
			)
			const start = performance.now()
			try {
				const id = await executor.submit(sql, queryId)
				debug(
					'clickhouse',
					`submit OK — id: ${id} (${Math.round(performance.now() - start)}ms)`,
				)
				return id
			} catch (error) {
				debug(
					'clickhouse',
					`submit FAILED (${Math.round(performance.now() - start)}ms)`,
					error instanceof Error ? error.message : error,
				)
				throw error
			}
		},
		async queryStatus(queryId: string, options?: { afterTime?: string }) {
			debug('clickhouse', `queryStatus for ${queryId}`)
			const start = performance.now()
			try {
				const status = await executor.queryStatus(queryId, options)
				debug(
					'clickhouse',
					`queryStatus: ${status.status} (${Math.round(performance.now() - start)}ms)`,
				)
				return status
			} catch (error) {
				debug(
					'clickhouse',
					`queryStatus FAILED (${Math.round(performance.now() - start)}ms)`,
					error instanceof Error ? error.message : error,
				)
				throw error
			}
		},
		async listSchemaObjects() {
			debug('clickhouse', 'listSchemaObjects')
			const start = performance.now()
			try {
				const objects = await executor.listSchemaObjects()
				debug(
					'clickhouse',
					`listSchemaObjects OK — ${objects.length} objects (${Math.round(performance.now() - start)}ms)`,
				)
				return objects
			} catch (error) {
				debug(
					'clickhouse',
					`listSchemaObjects FAILED (${Math.round(performance.now() - start)}ms)`,
					error instanceof Error ? error.message : error,
				)
				throw error
			}
		},
		async listTableDetails(databases: string[]) {
			debug(
				'clickhouse',
				`listTableDetails for databases: [${databases.join(', ')}]`,
			)
			const start = performance.now()
			try {
				const tables = await executor.listTableDetails(databases)
				debug(
					'clickhouse',
					`listTableDetails OK — ${tables.length} tables (${Math.round(performance.now() - start)}ms)`,
				)
				return tables
			} catch (error) {
				debug(
					'clickhouse',
					`listTableDetails FAILED (${Math.round(performance.now() - start)}ms)`,
					error instanceof Error ? error.message : error,
				)
				throw error
			}
		},
		async close(): Promise<void> {
			debug('clickhouse', 'closing connections')
			await executor.close()
		},
	}
}

function formatPluginError(
	pluginName: string,
	hook: string,
	error: unknown,
): Error {
	const message = error instanceof Error ? error.message : String(error)
	return new Error(`Plugin "${pluginName}" failed in ${hook}: ${message}`)
}

function validatePlugin(
	cliVersion: string,
	plugin: ChxPlugin,
	sourcePath: string,
): void {
	const name = plugin.manifest.name
	if (!name || name.trim().length === 0) {
		throw new Error(`Plugin at ${sourcePath} has an empty manifest.name.`)
	}

	if (plugin.manifest.apiVersion !== 1) {
		throw new Error(
			`Plugin "${name}" requires apiVersion=${String(plugin.manifest.apiVersion)} but CLI supports apiVersion=1.`,
		)
	}

	const compatibility = plugin.manifest.compatibility?.cli
	if (!compatibility) return

	const cliMajor = parseCliMajor(cliVersion)
	if (
		compatibility.minMajor !== undefined &&
		cliMajor < compatibility.minMajor
	) {
		throw new Error(
			`Plugin "${name}" is incompatible with CLI ${cliVersion}. Requires cli major >= ${compatibility.minMajor}.`,
		)
	}
	if (
		compatibility.maxMajor !== undefined &&
		cliMajor > compatibility.maxMajor
	) {
		throw new Error(
			`Plugin "${name}" is incompatible with CLI ${cliVersion}. Requires cli major <= ${compatibility.maxMajor}.`,
		)
	}
}

async function importPluginModule(absolutePath: string): Promise<ChxPlugin> {
	const mod = (await import(pathToFileURL(absolutePath).href)) as {
		default?: unknown
		plugin?: unknown
	}
	const candidate = (mod.default ?? mod.plugin) as ChxPlugin | undefined
	if (!candidate || typeof candidate !== 'object') {
		throw new Error(
			`Plugin module ${absolutePath} must export default definePlugin(...)`,
		)
	}
	if (!candidate.manifest || typeof candidate.manifest !== 'object') {
		throw new Error(`Plugin module ${absolutePath} is missing manifest.`)
	}
	return candidate
}

export async function loadPluginRuntime(input: {
	config: ResolvedChxConfig
	configPath: string
	cliVersion: string
	internalPlugins?: ChxPlugin[]
}): Promise<PluginRuntime> {
	const registrations = input.config.plugins ?? []
	const loaded: LoadedPlugin[] = []
	const byName = new Map<string, LoadedPlugin>()
	const configDir = resolve(input.configPath, '..')

	for (const registration of registrations) {
		const normalized = normalizePluginRegistration(registration)
		if (!normalized.enabled) continue

		const plugin =
			normalized.kind === 'inline'
				? normalized.inlinePlugin
				: await importPluginModule(resolve(configDir, normalized.resolvePath))
		if (!plugin) continue

		const sourceLabel =
			normalized.kind === 'inline'
				? `inline registration${normalized.nameHint ? ` (${normalized.nameHint})` : ''}`
				: resolve(configDir, normalized.resolvePath)
		validatePlugin(input.cliVersion, plugin, sourceLabel)

		if (normalized.nameHint && normalized.nameHint !== plugin.manifest.name) {
			throw new Error(
				`Plugin name mismatch for ${sourceLabel}: configured "${normalized.nameHint}" but manifest is "${plugin.manifest.name}".`,
			)
		}
		if (byName.has(plugin.manifest.name)) {
			throw new Error(
				`Duplicate plugin name "${plugin.manifest.name}" in config.plugins.`,
			)
		}

		debug(
			'plugin',
			`loaded "${plugin.manifest.name}" v${plugin.manifest.version ?? '?'}`,
			{
				hooks: Object.keys(plugin.hooks ?? {}),
				commands: (plugin.commands ?? []).map((c) => c.name),
			},
		)

		const item: LoadedPlugin = {
			plugin,
			options: normalized.options,
		}
		loaded.push(item)
		byName.set(plugin.manifest.name, item)
	}

	for (const plugin of input.internalPlugins ?? []) {
		if (byName.has(plugin.manifest.name)) continue
		const item: LoadedPlugin = { plugin, options: {} }
		loaded.push(item)
		byName.set(plugin.manifest.name, item)
	}

	async function runBeforePluginCommandHooks(
		pluginName: string,
		commandName: string,
		context: Omit<
			ChxOnBeforePluginCommandContext,
			'targetPlugin' | 'command' | 'options'
		>,
	): Promise<ChxOnBeforePluginCommandResult> {
		for (const item of loaded) {
			if (item.plugin.manifest.name === pluginName) continue
			const hook = item.plugin.hooks?.onBeforePluginCommand
			if (!hook) continue
			debug(
				'hook',
				`onBeforePluginCommand → ${item.plugin.manifest.name} (target: ${pluginName}:${commandName})`,
			)
			try {
				const result = await hook({
					...context,
					targetPlugin: pluginName,
					command: commandName,
					options: item.options,
				})
				if (result.handled) {
					debug(
						'hook',
						`onBeforePluginCommand ← ${item.plugin.manifest.name} handled command (exitCode: ${result.exitCode})`,
					)
					return result
				}
			} catch (error) {
				throw formatPluginError(
					item.plugin.manifest.name,
					'onBeforePluginCommand',
					error,
				)
			}
		}
		return { handled: false }
	}

	const NULL_EXECUTOR: ClickHouseExecutor = (() => {
		const err = () => {
			throw new Error(
				'No ClickHouse connection configured and no plugin provided an executor',
			)
		}
		return {
			command: err,
			query: err,
			insert: err,
			submit: err,
			queryStatus: err,
			listSchemaObjects: err,
			listTableDetails: err,
			close: () => Promise.resolve(),
		}
	})()

	return {
		plugins: loaded,
		async resolveContext(input) {
			const hasClickhouseConfig = !!input.config.clickhouse
			debug(
				'context',
				`resolving executor — clickhouse config: ${hasClickhouseConfig ? 'yes' : 'no'}`,
			)
			const rawExecutor = hasClickhouseConfig
				? createClickHouseExecutor(input.config.clickhouse!)
				: NULL_EXECUTOR
			const defaults: PluginContext = {
				executor: wrapExecutorWithDebug(rawExecutor),
				hasExecutor: hasClickhouseConfig,
			}
			let ctx = defaults
			for (const item of loaded) {
				const hook = item.plugin.hooks?.getContext
				if (!hook) continue
				try {
					const result = await hook({ ...input, defaults })
					if (
						result &&
						typeof result === 'object' &&
						'executor' in result &&
						result.executor
					) {
						debug(
							'context',
							`plugin "${item.plugin.manifest.name}" provided executor override`,
						)
						// Plugin returned an executor override — close the default one
						if (ctx.executor !== defaults.executor) {
							// A previous plugin already overrode — close that one
							await ctx.executor.close()
						} else if (
							ctx === defaults &&
							defaults.executor !== NULL_EXECUTOR
						) {
							// First override — close the default executor
							await defaults.executor.close()
						}
						ctx = { ...ctx, ...result, hasExecutor: true }
					}
				} catch (error) {
					await ctx.executor.close()
					throw formatPluginError(
						item.plugin.manifest.name,
						'getContext',
						error,
					)
				}
			}
			return ctx
		},
		async disposeContext(ctx) {
			await ctx.executor.close()
		},
		getCommand(pluginName, commandName) {
			const item = byName.get(pluginName)
			if (!item) return null
			const command = (item.plugin.commands ?? []).find(
				(entry) => entry.name === commandName,
			)
			if (!command) return null
			return { plugin: item, command }
		},
		async runOnInit(context) {
			for (const item of loaded) {
				const hook = item.plugin.hooks?.onInit
				if (!hook) continue
				debug('hook', `onInit → ${item.plugin.manifest.name}`)
				try {
					await hook({ ...context, options: item.options })
				} catch (error) {
					throw formatPluginError(item.plugin.manifest.name, 'onInit', error)
				}
			}
		},
		async runOnComplete(context) {
			const exitCode = context.exitCode ?? 0
			for (const item of loaded) {
				const hook = item.plugin.hooks?.onComplete
				if (!hook) continue
				debug(
					'hook',
					`onComplete → ${item.plugin.manifest.name} (exitCode: ${exitCode})`,
				)
				try {
					await hook({ ...context, exitCode, options: item.options })
				} catch (error) {
					throw formatPluginError(
						item.plugin.manifest.name,
						'onComplete',
						error,
					)
				}
			}
		},
		async runOnConfigLoaded(context) {
			const tableScope = context.tableScope ?? UNFILTERED_TABLE_SCOPE
			for (const item of loaded) {
				const hook = item.plugin.hooks?.onConfigLoaded
				if (!hook) continue
				debug('hook', `onConfigLoaded → ${item.plugin.manifest.name}`)
				try {
					await hook({ ...context, options: item.options, tableScope })
				} catch (error) {
					throw formatPluginError(
						item.plugin.manifest.name,
						'onConfigLoaded',
						error,
					)
				}
			}
		},
		async runOnSchemaLoaded(context) {
			let definitions = context.definitions
			for (const item of loaded) {
				const hook = item.plugin.hooks?.onSchemaLoaded
				if (!hook) continue
				debug(
					'hook',
					`onSchemaLoaded → ${item.plugin.manifest.name} (${definitions.length} definitions)`,
				)
				try {
					const next = await hook({ ...context, definitions })
					if (Array.isArray(next)) {
						debug(
							'hook',
							`onSchemaLoaded ← ${item.plugin.manifest.name} returned ${next.length} definitions`,
						)
						definitions = canonicalizeDefinitions(next)
					}
				} catch (error) {
					throw formatPluginError(
						item.plugin.manifest.name,
						'onSchemaLoaded',
						error,
					)
				}
			}
			return definitions
		},
		async runOnPlanCreated(context, initialPlan) {
			const tableScope = context.tableScope ?? UNFILTERED_TABLE_SCOPE
			let plan = initialPlan
			for (const item of loaded) {
				const hook = item.plugin.hooks?.onPlanCreated
				if (!hook) continue
				debug(
					'hook',
					`onPlanCreated → ${item.plugin.manifest.name} (${plan.operations.length} operations)`,
				)
				try {
					const next = await hook({ ...context, tableScope, plan })
					if (next) {
						debug(
							'hook',
							`onPlanCreated ← ${item.plugin.manifest.name} modified plan (${next.operations.length} operations)`,
						)
						plan = next
					}
				} catch (error) {
					throw formatPluginError(
						item.plugin.manifest.name,
						'onPlanCreated',
						error,
					)
				}
			}
			return plan
		},
		async runOnBeforeApply(context) {
			let statements = context.statements
			for (const item of loaded) {
				const hook = item.plugin.hooks?.onBeforeApply
				if (!hook) continue
				debug(
					'hook',
					`onBeforeApply → ${item.plugin.manifest.name} (${context.migration}, ${statements.length} statements)`,
				)
				try {
					const result = await hook({ ...context, statements })
					if (result?.statements) {
						debug(
							'hook',
							`onBeforeApply ← ${item.plugin.manifest.name} modified statements (${result.statements.length})`,
						)
						statements = result.statements
					}
				} catch (error) {
					throw formatPluginError(
						item.plugin.manifest.name,
						'onBeforeApply',
						error,
					)
				}
			}
			return statements
		},
		async runOnAfterApply(context) {
			for (const item of loaded) {
				const hook = item.plugin.hooks?.onAfterApply
				if (!hook) continue
				debug(
					'hook',
					`onAfterApply → ${item.plugin.manifest.name} (${context.migration})`,
				)
				try {
					await hook(context)
				} catch (error) {
					throw formatPluginError(
						item.plugin.manifest.name,
						'onAfterApply',
						error,
					)
				}
			}
		},
		async runOnCheck(context) {
			const tableScope = context.tableScope ?? UNFILTERED_TABLE_SCOPE
			const results: ChxOnCheckResult[] = []
			for (const item of loaded) {
				const hook = item.plugin.hooks?.onCheck
				if (!hook) continue
				debug('hook', `onCheck → ${item.plugin.manifest.name}`)
				try {
					const result = await hook({
						...context,
						options: item.options,
						tableScope,
					})
					if (!result) continue
					debug(
						'hook',
						`onCheck ← ${item.plugin.manifest.name}: ok=${result.ok}, findings=${result.findings.length}`,
					)
					results.push({
						plugin: result.plugin || item.plugin.manifest.name,
						evaluated: result.evaluated,
						ok: result.ok,
						findings: result.findings,
						metadata: result.metadata,
					})
				} catch (error) {
					throw formatPluginError(item.plugin.manifest.name, 'onCheck', error)
				}
			}
			return results
		},
		async runOnCheckReport(results, print) {
			for (const result of results) {
				const item = byName.get(result.plugin)
				if (!item) continue
				const hook = item.plugin.hooks?.onCheckReport
				if (!hook) continue
				try {
					await hook({ result, print })
				} catch (error) {
					throw formatPluginError(
						item.plugin.manifest.name,
						'onCheckReport',
						error,
					)
				}
			}
		},
		runOnBeforePluginCommand: runBeforePluginCommandHooks,
		async runPluginCommand(pluginName, commandName, context) {
			debug('command', `running plugin command "${pluginName}:${commandName}"`)
			const item = byName.get(pluginName)
			if (!item) return 1
			const command = (item.plugin.commands ?? []).find(
				(entry) => entry.name === commandName,
			)
			if (!command) return 1

			// Run onBeforePluginCommand hooks — if any returns handled, skip the command
			const beforeResult = await runBeforePluginCommandHooks(
				pluginName,
				commandName,
				{
					config: context.config,
					configPath: context.configPath,
					jsonMode: context.jsonMode,
					args: context.args,
					flags: context.flags,
					tableScope: context.tableScope ?? UNFILTERED_TABLE_SCOPE,
					print: context.print,
				},
			)
			if (beforeResult.handled) return beforeResult.exitCode

			try {
				const code = await command.run({
					...context,
					pluginName,
					options: item.options,
					tableScope: context.tableScope ?? UNFILTERED_TABLE_SCOPE,
				})
				return typeof code === 'number' ? code : 0
			} catch (error) {
				throw formatPluginError(
					item.plugin.manifest.name,
					`command:${commandName}`,
					error,
				)
			}
		},
	}
}
