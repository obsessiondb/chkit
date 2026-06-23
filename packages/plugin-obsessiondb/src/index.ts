import type {
	ChxInlinePluginRegistration,
	ResolvedChxConfig,
	SchemaDefinition,
} from '@chkit/core'

import { AUTH_COMMANDS, loadCredentials, resolveBaseUrl } from './auth/index.js'
import {
	BACKFILL_EXTEND_COMMANDS,
	handleBackfillCommand,
} from './backfill/index.js'
import { createRemoteExecutor } from './query/remote-executor.js'
import { listServices } from './service/api.js'
import { SERVICE_COMMAND } from './service/commands.js'
import { loadSelectedService, loadServiceAliases } from './service/storage.js'
import type { SelectedService } from './service/types.js'

export {
	type Credentials,
	loadCredentials,
	resolveBaseUrl,
} from './auth/index.js'
export { createJobsClient, type JobsClient } from './backfill/index.js'
export {
	type ConnectChoice,
	type OnboardingOptions,
	runOnboarding,
} from './onboarding/index.js'
export {
	loadSelectedService,
	loadServiceAliases,
	removeServiceAlias,
	saveServiceAlias,
} from './service/storage.js'
export type { SelectedService, ServiceAliases } from './service/types.js'

export type ObsessionDBPluginOptions = Record<string, never>

interface PluginCommand {
	name: string
	description: string
	flags?: ReadonlyArray<{ name: string; type: string; description: string }>
	run: (context: Record<string, unknown>) => unknown
}

interface BeforePluginCommandContext {
	targetPlugin: string
	command: string
	config: Record<string, unknown>
	configPath: string
	jsonMode: boolean
	args: string[]
	flags: Record<string, string | string[] | boolean | undefined>
	options: Record<string, unknown>
	print: (value: unknown) => void
}

interface BeforePluginCommandResult {
	handled: boolean
	exitCode?: number
}

interface GetContextInput {
	config: ResolvedChxConfig
	configPath: string
	command: string
	flags: Record<string, unknown>
	defaults: Record<string, unknown>
}

interface ObsessionDBPlugin {
	manifest: { name: 'obsessiondb'; apiVersion: 1 }
	commands: PluginCommand[]
	extendCommands: Array<{
		command: string[]
		flags: Array<{
			name: string
			type: 'boolean' | 'string'
			description: string
		}>
	}>
	hooks: {
		getContext(
			input: GetContextInput,
		): Promise<{ executor: unknown } | undefined>
		onInit(context: {
			command: string
			configPath: string
			isInteractive: boolean
			jsonMode: boolean
			flags: Record<string, string | string[] | boolean | undefined>
			config?: ResolvedChxConfig
		}): Promise<void>
		onSchemaLoaded(context: {
			config: ResolvedChxConfig
			flags: Record<string, string | string[] | boolean | undefined>
			jsonMode?: boolean
			definitions: SchemaDefinition[]
		}): SchemaDefinition[] | undefined
		onBeforePluginCommand(
			context: BeforePluginCommandContext,
		): Promise<BeforePluginCommandResult>
	}
}

type ObsessionDBRegistration = ChxInlinePluginRegistration<
	ObsessionDBPlugin,
	ObsessionDBPluginOptions
>

export function isObsessionDBHost(url: string): boolean {
	try {
		const { hostname } = new URL(url)
		return (
			hostname === 'obsessiondb.com' ||
			hostname.endsWith('.obsessiondb.com') ||
			hostname === 'obsession.numia-dev.com' ||
			hostname.endsWith('.obsession.numia-dev.com')
		)
	} catch {
		return false
	}
}

export function resolveStripBehavior(
	config: ResolvedChxConfig,
	flags: Record<string, string | string[] | boolean | undefined>,
): boolean {
	if (flags['force-shared-engines']) return false
	if (flags['no-shared-engines']) return true
	// Auto-detect: if targeting ObsessionDB, keep Shared engines
	const url = config.clickhouse?.url
	if (url && isObsessionDBHost(url)) return false
	return true
}

export function stripSharedPrefix(engine: string): string {
	return engine.replace(/^Shared/, '')
}

async function resolveServiceOverride(input: {
	configPath: string
	credentials: NonNullable<Awaited<ReturnType<typeof loadCredentials>>>
	name: string
}): Promise<SelectedService> {
	const services = await listServices(input.credentials)
	const service = services.find((candidate) => candidate.name === input.name)
	if (service) {
		return { service_slug: service.slug, service_name: service.name }
	}

	const aliases = await loadServiceAliases(input.configPath)
	const alias = aliases[input.name]
	if (alias) return alias

	const availableServices =
		services.map((candidate) => candidate.name).join(', ') || '<none>'
	const availableAliases = Object.keys(aliases).sort().join(', ') || '<none>'
	throw new Error(
		`obsessiondb: service "${input.name}" not found. Available services: ${availableServices}. Available aliases: ${availableAliases}`,
	)
}

function stripCloudSettings(
	settings: Record<string, string | number | boolean> | undefined,
): {
	settings: Record<string, string | number | boolean> | undefined
	stripped: string[]
} {
	if (!settings) return { settings, stripped: [] }
	const CLOUD_ONLY_SETTINGS = ['storage_policy']
	const stripped: string[] = []
	let result: Record<string, string | number | boolean> | undefined
	for (const key of CLOUD_ONLY_SETTINGS) {
		if (key in settings) {
			if (!result) result = { ...settings }
			delete result[key]
			stripped.push(key)
		}
	}
	if (!result) return { settings, stripped: [] }
	return {
		settings: Object.keys(result).length > 0 ? result : undefined,
		stripped,
	}
}

export function rewriteSharedEngines(definitions: SchemaDefinition[]): {
	definitions: SchemaDefinition[]
	count: number
	strippedSettings: string[]
} {
	let count = 0
	const allStrippedSettings: string[] = []
	const rewritten = definitions.map((def) => {
		if (def.kind !== 'table') return def
		const hasSharedEngine = def.engine.startsWith('Shared')
		const { settings, stripped } = stripCloudSettings(def.settings)
		if (!hasSharedEngine && stripped.length === 0) return def
		if (hasSharedEngine) count++
		allStrippedSettings.push(...stripped)
		return {
			...def,
			engine: hasSharedEngine ? stripSharedPrefix(def.engine) : def.engine,
			settings,
		}
	})
	return {
		definitions: rewritten,
		count,
		strippedSettings: allStrippedSettings,
	}
}

function createObsessionDBPlugin(
	_options: ObsessionDBPluginOptions,
): ObsessionDBPlugin {
	return {
		manifest: { name: 'obsessiondb', apiVersion: 1 },
		commands: [...AUTH_COMMANDS, SERVICE_COMMAND] as unknown as PluginCommand[],
		extendCommands: [
			{
				command: ['generate', 'migrate', 'status', 'drift', 'check'],
				flags: [
					{
						name: '--force-shared-engines',
						type: 'boolean',
						description: 'Keep Shared engine prefixes (skip stripping)',
					},
					{
						name: '--no-shared-engines',
						type: 'boolean',
						description: 'Strip Shared engine prefixes (even on ObsessionDB)',
					},
				],
			},
			{
				command: ['generate', 'migrate', 'status', 'drift', 'check', 'query'],
				flags: [
					{
						name: '--service',
						type: 'string',
						description:
							'Override the selected ObsessionDB service by name for this command',
					},
				],
			},
			...BACKFILL_EXTEND_COMMANDS,
		],
		hooks: {
			async getContext({ config, configPath, command, flags }) {
				const creds = await loadCredentials()
				if (!creds) return
				const effectiveCreds = {
					...creds,
					base_url: resolveBaseUrl(creds.base_url),
				}

				const serviceOverride = flags['--service']
				const overrideName =
					typeof serviceOverride === 'string' ? serviceOverride.trim() : ''

				let service: SelectedService | null
				if (overrideName.length > 0) {
					service = await resolveServiceOverride({
						configPath,
						credentials: effectiveCreds,
						name: overrideName,
					})
				} else {
					service = await loadSelectedService(configPath)
				}
				if (!service) {
					if (command === 'query' && !config.clickhouse) {
						throw new Error(
							'authenticated but no ObsessionDB service is selected. Run `chkit obsessiondb service select` or pass `--service <name>`.',
						)
					}
					return
				}

				return {
					executor: createRemoteExecutor({
						credentials: effectiveCreds,
						serviceSlug: service.service_slug,
					}),
				}
			},
			async onInit(context) {
				if (context.jsonMode) return
				if (context.command === 'obsessiondb') return
				const creds = await loadCredentials()
				if (!creds) return
				const effectiveCreds = {
					...creds,
					base_url: resolveBaseUrl(creds.base_url),
				}
				const serviceOverride = context.flags['--service']
				const overrideName =
					typeof serviceOverride === 'string' ? serviceOverride.trim() : ''

				let service: SelectedService | null
				if (overrideName.length > 0) {
					try {
						service = await resolveServiceOverride({
							configPath: context.configPath,
							credentials: effectiveCreds,
							name: overrideName,
						})
					} catch {
						return
					}
				} else {
					service = await loadSelectedService(context.configPath)
				}
				if (service) {
					console.log(`obsessiondb: using service "${service.service_name}"\n`)
				} else if (context.command === 'query' || context.config?.clickhouse) {
					// Suppress the "no service selected" reminder when the user has a
					// direct `clickhouse` target configured: ObsessionDB was layered in
					// from a global `chkit obsessiondb login` profile, not chosen for this
					// project, so service selection is irrelevant and the notice is noise.
					return
				} else {
					console.log(
						'obsessiondb: authenticated but no service selected (run `chkit obsessiondb service select` or pass `--service <name>`)',
					)
				}
			},
			onSchemaLoaded(context) {
				const shouldStrip = resolveStripBehavior(context.config, context.flags)
				if (!shouldStrip) return

				const rewritten = rewriteSharedEngines(context.definitions)
				if (!context.jsonMode && rewritten.count > 0) {
					console.log(
						`obsessiondb: Rewrote ${rewritten.count} Shared engine(s) to standard ClickHouse equivalents.`,
					)
				}
				if (!context.jsonMode && rewritten.strippedSettings.length > 0) {
					const unique = [...new Set(rewritten.strippedSettings)]
					console.log(
						`obsessiondb: Stripped cloud-only setting(s): ${unique.join(', ')}`,
					)
				}
				return rewritten.definitions
			},
			async onBeforePluginCommand(context) {
				return handleBackfillCommand(context)
			},
		},
	}
}

export function obsessiondb(
	options: ObsessionDBPluginOptions = {},
): ObsessionDBRegistration {
	return {
		plugin: createObsessionDBPlugin(options),
		name: 'obsessiondb',
		enabled: true,
		options,
	}
}
