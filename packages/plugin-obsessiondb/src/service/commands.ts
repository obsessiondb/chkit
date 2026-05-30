import { loadCredentials, resolveBaseUrl } from '../auth/index.js'
import { listServiceOrganizations, listServices } from './api.js'
import {
	renderServiceOrganizations,
	selectServiceInteractive,
	serviceChoiceLabel,
} from './select.js'
import {
	loadSelectedService,
	loadServiceAliases,
	removeServiceAlias,
	saveSelectedService,
	saveServiceAlias,
} from './storage.js'

interface PluginCommandContext {
	configPath: string
	args: string[]
	flags: Record<string, string | string[] | boolean | undefined>
	print: (value: unknown) => void
}

interface PluginCommand {
	name: string
	description: string
	run: (context: PluginCommandContext) => Promise<number>
}

async function loadEffectiveCredentials(
	print: (msg: string) => void,
): Promise<NonNullable<Awaited<ReturnType<typeof loadCredentials>>> | null> {
	const creds = await loadCredentials()
	if (!creds) {
		print('Not logged in. Run `chkit obsessiondb login` to authenticate.')
		return null
	}
	return {
		...creds,
		base_url: resolveBaseUrl(creds.base_url),
	}
}

async function runServiceSelect(
	context: PluginCommandContext,
): Promise<number> {
	const print = (msg: string) => context.print(msg)
	const effectiveCreds = await loadEffectiveCredentials(print)
	if (!effectiveCreds) return 1

	const organizations = await listServiceOrganizations(effectiveCreds)
	const selected = await selectServiceInteractive(organizations, print)
	if (!selected) return 1

	await saveSelectedService(context.configPath, {
		service_slug: selected.service.slug,
		service_name: selected.service.name,
	})

	print(`Service selected: ${serviceChoiceLabel(selected)}`)
	return 0
}

function serviceArgs(args: string[]): string[] {
	return args[0] === 'service' ? args.slice(1) : args
}

function printServiceUsage(print: (msg: string) => void): void {
	print('Usage:')
	print('  chkit obsessiondb service list')
	print('  chkit obsessiondb service select')
	print('  chkit obsessiondb service alias list')
	print('  chkit obsessiondb service alias set <alias> <service-name>')
	print('  chkit obsessiondb service alias remove <alias>')
}

export const SERVICE_COMMAND: PluginCommand = {
	name: 'service',
	description: 'Manage ObsessionDB services',
	async run(context) {
		const print = (msg: string) => context.print(msg)
		const [action] = serviceArgs(context.args)

		if (
			!action ||
			action === 'help' ||
			action === '--help' ||
			action === '-h'
		) {
			printServiceUsage(print)
			return action ? 0 : 1
		}

		if (action === 'list' || action === 'ls') {
			const effectiveCreds = await loadEffectiveCredentials(print)
			if (!effectiveCreds) return 1

			const [organizations, selected] = await Promise.all([
				listServiceOrganizations(effectiveCreds),
				loadSelectedService(context.configPath),
			])
			for (const line of renderServiceOrganizations(organizations, selected)) {
				print(line)
			}
			return 0
		}

		if (action === 'select') {
			return runServiceSelect(context)
		}

		if (action === 'alias') {
			return runServiceAlias(context)
		}

		print(`Unknown service action: ${action}`)
		printServiceUsage(print)
		return 1
	},
}

function serviceAliasArgs(args: string[]): string[] {
	if (args[0] === 'service' && args[1] === 'alias') return args.slice(2)
	if (args[0] === 'alias') return args.slice(1)
	return args
}

function printServiceAliasUsage(print: (msg: string) => void): void {
	print('Usage:')
	print('  chkit obsessiondb service alias list')
	print('  chkit obsessiondb service alias set <alias> <service-name>')
	print('  chkit obsessiondb service alias remove <alias>')
}

function validateAlias(alias: string): string | null {
	if (alias.trim().length === 0) return 'Alias is required.'
	if (alias !== alias.trim())
		return 'Alias cannot start or end with whitespace.'
	if (alias.startsWith('--')) return 'Alias cannot start with "--".'
	return null
}

async function runServiceAlias(context: PluginCommandContext): Promise<number> {
	const print = (msg: string) => context.print(msg)
	const [action, alias, ...serviceNameParts] = serviceAliasArgs(context.args)

	if (!action || action === 'help' || action === '--help' || action === '-h') {
		printServiceAliasUsage(print)
		return action ? 0 : 1
	}

	if (action === 'list' || action === 'ls') {
		const aliases = await loadServiceAliases(context.configPath)
		const entries = Object.entries(aliases).sort(([a], [b]) =>
			a.localeCompare(b),
		)
		if (entries.length === 0) {
			print('No service aliases defined.')
			return 0
		}
		print('Service aliases:')
		for (const [name, service] of entries) {
			print(`  ${name} -> ${service.service_name}`)
		}
		return 0
	}

	if (action === 'remove' || action === 'rm' || action === 'delete') {
		if (!alias) {
			print('Alias is required.')
			printServiceAliasUsage(print)
			return 1
		}
		const removed = await removeServiceAlias(context.configPath, alias)
		print(
			removed
				? `Service alias removed: ${alias}`
				: `Service alias not found: ${alias}`,
		)
		return removed ? 0 : 1
	}

	if (action === 'set' || action === 'add') {
		if (!alias) {
			print('Alias is required.')
			printServiceAliasUsage(print)
			return 1
		}
		const aliasError = validateAlias(alias)
		if (aliasError) {
			print(aliasError)
			return 1
		}

		const serviceName = serviceNameParts.join(' ').trim()
		if (serviceName.length === 0) {
			print('Service name is required.')
			printServiceAliasUsage(print)
			return 1
		}

		const creds = await loadCredentials()
		if (!creds) {
			print('Not logged in. Run `chkit obsessiondb login` to authenticate.')
			return 1
		}

		const effectiveCreds = {
			...creds,
			base_url: resolveBaseUrl(creds.base_url),
		}
		const services = await listServices(effectiveCreds)
		const service = services.find((candidate) => candidate.name === serviceName)
		if (!service) {
			const available =
				services.map((candidate) => candidate.name).join(', ') || '<none>'
			print(
				`Service not found: ${serviceName}. Available services: ${available}`,
			)
			return 1
		}
		if (services.some((candidate) => candidate.name === alias)) {
			print(
				`Alias "${alias}" matches an existing service name; use --service ${alias} directly.`,
			)
			return 1
		}

		await saveServiceAlias(context.configPath, alias, {
			service_slug: service.slug,
			service_name: service.name,
		})
		print(`Service alias saved: ${alias} -> ${service.name}`)
		return 0
	}

	print(`Unknown service alias action: ${action}`)
	printServiceAliasUsage(print)
	return 1
}
