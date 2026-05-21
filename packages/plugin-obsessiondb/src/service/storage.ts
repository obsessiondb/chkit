import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import { isSynthesizedConfigPath } from '@chkit/core'

import type { SelectedService, ServiceAliases } from './types.js'

interface ServiceConfig {
	service_id?: string
	service_name?: string
	aliases?: ServiceAliases
}

function getUserConfigDir(): string {
	const xdgConfig = process.env.XDG_CONFIG_HOME
	const configDir =
		xdgConfig && xdgConfig.length > 0 ? xdgConfig : join(homedir(), '.config')
	return join(configDir, 'chkit')
}

function isUnderUserConfigDir(path: string, userDir: string): boolean {
	const target = resolve(path)
	const dir = resolve(userDir)
	return target === dir || target.startsWith(`${dir}/`)
}

export function getServicePath(
	configPath: string,
	userDir: string = getUserConfigDir(),
): string {
	if (
		isSynthesizedConfigPath(configPath) ||
		isUnderUserConfigDir(configPath, userDir)
	) {
		return join(userDir, 'obsessiondb.json')
	}
	const configDir = resolve(configPath, '..')
	return join(configDir, '.chkit', 'obsessiondb.json')
}

function readSelectedService(parsed: unknown): SelectedService | null {
	if (
		typeof parsed === 'object' &&
		parsed !== null &&
		'service_id' in parsed &&
		'service_name' in parsed &&
		typeof (parsed as SelectedService).service_id === 'string' &&
		typeof (parsed as SelectedService).service_name === 'string'
	) {
		return {
			service_id: (parsed as SelectedService).service_id,
			service_name: (parsed as SelectedService).service_name,
		}
	}
	return null
}

function readAliases(parsed: unknown): ServiceAliases {
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('aliases' in parsed) ||
		typeof (parsed as { aliases?: unknown }).aliases !== 'object' ||
		(parsed as { aliases?: unknown }).aliases === null
	) {
		return {}
	}

	const aliases: ServiceAliases = {}
	for (const [alias, value] of Object.entries(
		(parsed as { aliases: Record<string, unknown> }).aliases,
	)) {
		const service = readSelectedService(value)
		if (alias.length > 0 && service) aliases[alias] = service
	}
	return aliases
}

async function loadServiceConfig(configPath: string): Promise<ServiceConfig> {
	try {
		const raw = await readFile(getServicePath(configPath), 'utf8')
		const parsed = JSON.parse(raw) as unknown
		const service = readSelectedService(parsed)
		const aliases = readAliases(parsed)
		return {
			...(service ?? {}),
			...(Object.keys(aliases).length > 0 ? { aliases } : {}),
		}
	} catch {
		return {}
	}
}

async function saveServiceConfig(
	configPath: string,
	config: ServiceConfig,
): Promise<void> {
	const filePath = getServicePath(configPath)
	await mkdir(dirname(filePath), { recursive: true })
	await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`)
}

export async function loadSelectedService(
	configPath: string,
): Promise<SelectedService | null> {
	const config = await loadServiceConfig(configPath)
	if (
		typeof config.service_id !== 'string' ||
		typeof config.service_name !== 'string'
	) {
		return null
	}
	return {
		service_id: config.service_id,
		service_name: config.service_name,
	}
}

export async function saveSelectedService(
	configPath: string,
	service: SelectedService,
): Promise<void> {
	const existing = await loadServiceConfig(configPath)
	await saveServiceConfig(configPath, {
		...existing,
		service_id: service.service_id,
		service_name: service.service_name,
	})
}

export async function loadServiceAliases(
	configPath: string,
): Promise<ServiceAliases> {
	const config = await loadServiceConfig(configPath)
	return config.aliases ?? {}
}

export async function saveServiceAlias(
	configPath: string,
	alias: string,
	service: SelectedService,
): Promise<void> {
	const existing = await loadServiceConfig(configPath)
	await saveServiceConfig(configPath, {
		...existing,
		aliases: {
			...(existing.aliases ?? {}),
			[alias]: service,
		},
	})
}

export async function removeServiceAlias(
	configPath: string,
	alias: string,
): Promise<boolean> {
	const existing = await loadServiceConfig(configPath)
	const aliases = { ...(existing.aliases ?? {}) }
	if (!(alias in aliases)) return false
	delete aliases[alias]
	await saveServiceConfig(configPath, {
		...existing,
		aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
	})
	return true
}
