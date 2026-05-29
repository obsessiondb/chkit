import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { listServiceOrganizations } from '../service/api.js'
import {
	selectServiceInteractive,
	serviceChoiceLabel,
} from '../service/select.js'
import { loadSelectedService, saveSelectedService } from '../service/storage.js'
import { getSession, pollDeviceToken, requestDeviceCode } from './api-client.js'
import {
	clearCredentials,
	loadCredentials,
	resolveBaseUrl,
	saveCredentials,
} from './credentials.js'

function openBrowser(url: string): void {
	const cmd =
		platform() === 'darwin'
			? 'open'
			: platform() === 'win32'
				? 'start'
				: 'xdg-open'
	execFile(cmd, [url], () => {
		// Silently ignore errors — user can open the URL manually
	})
}

async function promptServiceSelection(
	baseUrl: string,
	token: string,
	configPath: string,
	print: (msg: string) => void,
): Promise<void> {
	const effectiveCreds = {
		access_token: token,
		base_url: resolveBaseUrl(baseUrl),
	}
	try {
		const organizations = await listServiceOrganizations(effectiveCreds)
		const selected = await selectServiceInteractive(organizations, print)
		if (selected) {
			await saveSelectedService(configPath, {
				service_slug: selected.service.slug,
				service_name: selected.service.name,
			})
			print(`Service selected: ${serviceChoiceLabel(selected)}`)
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		print(`Could not fetch services: ${msg}`)
		print(
			'You can select a service later with: chkit obsessiondb service select',
		)
	}
}

export async function runLogin(
	baseUrl: string,
	configPath: string,
	print: (msg: string) => void,
): Promise<number> {
	const existing = await loadCredentials()
	if (existing) {
		try {
			const session = await getSession(existing.base_url, existing.access_token)
			print(`Already logged in as ${session.user.email}`)

			// Check if service is selected; if not, prompt
			const service = await loadSelectedService(configPath)
			if (!service) {
				await promptServiceSelection(
					existing.base_url,
					existing.access_token,
					configPath,
					print,
				)
			}
			return 0
		} catch {
			// Token expired or invalid — proceed with fresh login
			await clearCredentials()
		}
	}

	const device = await requestDeviceCode(baseUrl)

	print(
		`\nOpen this URL in your browser:\n  ${device.verification_uri_complete}\n`,
	)
	print(`Enter code: ${device.user_code}\n`)

	openBrowser(device.verification_uri_complete)

	print('Waiting for authorization...')

	const token = await pollDeviceToken(
		baseUrl,
		device.device_code,
		device.interval,
		device.expires_in,
	)

	await saveCredentials({ access_token: token, base_url: baseUrl })

	const session = await getSession(baseUrl, token)
	print(`Logged in as ${session.user.email}`)

	// Prompt for service selection after successful auth
	await promptServiceSelection(baseUrl, token, configPath, print)

	return 0
}

export async function runLogout(print: (msg: string) => void): Promise<number> {
	await clearCredentials()
	print('Logged out.')
	return 0
}

export async function runWhoami(print: (msg: string) => void): Promise<number> {
	const creds = await loadCredentials()
	if (!creds) {
		print('Not logged in. Run `chkit obsessiondb login` to authenticate.')
		return 1
	}

	try {
		const session = await getSession(creds.base_url, creds.access_token)
		print(`Logged in as ${session.user.email} (${session.user.name})`)
		return 0
	} catch {
		await clearCredentials()
		print('Session expired. Run `chkit obsessiondb login` to re-authenticate.')
		return 1
	}
}
