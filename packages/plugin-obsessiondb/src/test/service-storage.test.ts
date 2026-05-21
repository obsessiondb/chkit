import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	getServicePath,
	loadServiceAliases,
	saveSelectedService,
	saveServiceAlias,
} from '../service/storage.js'

interface Sandbox {
	root: string
	project: string
	userConfigDir: string
	cleanup: () => void
}

function createSandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), 'chkit-service-'))
	const project = join(root, 'project')
	const userConfigDir = join(root, 'xdg', 'chkit')
	mkdirSync(project, { recursive: true })
	mkdirSync(userConfigDir, { recursive: true })
	return {
		root,
		project,
		userConfigDir,
		cleanup() {
			rmSync(root, { recursive: true, force: true })
		},
	}
}

describe('getServicePath', () => {
	test('resolves to project .chkit/obsessiondb.json when config sits in a project dir', () => {
		const sandbox = createSandbox()
		const configPath = join(sandbox.project, 'clickhouse.config.ts')

		const path = getServicePath(configPath, sandbox.userConfigDir)

		expect(path).toBe(join(sandbox.project, '.chkit', 'obsessiondb.json'))
		sandbox.cleanup()
	})

	test('resolves to user dir directly when config sits under user config dir', () => {
		const sandbox = createSandbox()
		const configPath = join(sandbox.userConfigDir, 'clickhouse.config.ts')

		const path = getServicePath(configPath, sandbox.userConfigDir)

		expect(path).toBe(join(sandbox.userConfigDir, 'obsessiondb.json'))
		sandbox.cleanup()
	})

	test('resolves to user dir for any nested path under user config dir', () => {
		const sandbox = createSandbox()
		const configPath = join(
			sandbox.userConfigDir,
			'subdir',
			'clickhouse.config.ts',
		)

		const path = getServicePath(configPath, sandbox.userConfigDir)

		expect(path).toBe(join(sandbox.userConfigDir, 'obsessiondb.json'))
		sandbox.cleanup()
	})

	test('resolves to user dir when config is the synthesized sentinel path', () => {
		const sandbox = createSandbox()

		const path = getServicePath('<default:obsessiondb>', sandbox.userConfigDir)

		expect(path).toBe(join(sandbox.userConfigDir, 'obsessiondb.json'))
		sandbox.cleanup()
	})
})

describe('service aliases', () => {
	test('saves aliases next to the selected service', async () => {
		const sandbox = createSandbox()
		const configPath = join(sandbox.project, 'clickhouse.config.ts')
		try {
			await saveSelectedService(configPath, {
				service_id: 'svc-prod',
				service_name: 'production',
			})
			await saveServiceAlias(configPath, 'prod', {
				service_id: 'svc-prod',
				service_name: 'production',
			})

			const aliases = await loadServiceAliases(configPath)
			expect(aliases.prod).toEqual({
				service_id: 'svc-prod',
				service_name: 'production',
			})

			const raw = JSON.parse(
				await readFile(getServicePath(configPath), 'utf8'),
			) as {
				service_id: string
				aliases: Record<string, unknown>
			}
			expect(raw.service_id).toBe('svc-prod')
			expect(raw.aliases.prod).toBeDefined()
		} finally {
			sandbox.cleanup()
		}
	})

	test('preserves aliases when changing the selected service', async () => {
		const sandbox = createSandbox()
		const configPath = join(sandbox.project, 'clickhouse.config.ts')
		try {
			await saveServiceAlias(configPath, 'prod', {
				service_id: 'svc-prod',
				service_name: 'production',
			})
			await saveSelectedService(configPath, {
				service_id: 'svc-staging',
				service_name: 'staging',
			})

			const aliases = await loadServiceAliases(configPath)
			expect(aliases.prod).toEqual({
				service_id: 'svc-prod',
				service_name: 'production',
			})
		} finally {
			sandbox.cleanup()
		}
	})
})
