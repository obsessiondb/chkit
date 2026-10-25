import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import * as Effect from 'effect/Effect'
import { failureValue, fromPromise, runEffect } from '../runtime.js'
import { listServiceOrganizations } from '../service/api.js'
import {
	selectServiceInteractive,
	serviceChoiceLabel,
} from '../service/select.js'
import { loadSelectedService, saveSelectedService } from '../service/storage.js'
import { errorEnvelope, whoamiEnvelope } from '../json-envelope.js'
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

function promptServiceSelection(
	baseUrl: string,
	token: string,
	configPath: string,
	print: (msg: string) => void,
): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		const effectiveCreds = {
			access_token: token,
			base_url: resolveBaseUrl(baseUrl),
		}
		const organizations = yield* fromPromise(() =>
			listServiceOrganizations(effectiveCreds),
		)
		const selected = yield* fromPromise(() =>
			selectServiceInteractive(organizations, print),
		)
		if (selected) {
			yield* fromPromise(() =>
				saveSelectedService(configPath, {
					service_slug: selected.service.slug,
					service_name: selected.service.name,
				}),
			)
			print(`Service selected: ${serviceChoiceLabel(selected)}`)
		}
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.sync(() => {
				const error = failureValue(cause)
				const msg = error instanceof Error ? error.message : String(error)
				print(`Could not fetch services: ${msg}`)
				print(
					'You can select a service later with: chkit obsessiondb service select',
				)
			}),
		),
	)
}

export async function runLogin(
	baseUrl: string,
	configPath: string,
	print: (msg: string) => void,
): Promise<number> {
	return runEffect(
		Effect.gen(function* () {
			const existing = yield* fromPromise(() => loadCredentials())
			if (existing) {
				const reused = yield* Effect.gen(function* () {
					const session = yield* fromPromise(() =>
						getSession(existing.base_url, existing.access_token),
					)
					print(`Already logged in as ${session.user.email}`)

					// Check if service is selected; if not, prompt
					const service = yield* fromPromise(() =>
						loadSelectedService(configPath),
					)
					if (!service) {
						yield* promptServiceSelection(
							existing.base_url,
							existing.access_token,
							configPath,
							print,
						)
					}
					return true
				}).pipe(
					Effect.catchCause(() =>
						Effect.gen(function* () {
							// Token expired or invalid — proceed with fresh login
							yield* fromPromise(() => clearCredentials())
							return false
						}),
					),
				)
				if (reused) return 0
			}

			const device = yield* fromPromise(() => requestDeviceCode(baseUrl))

			print(
				`\nOpen this URL in your browser:\n  ${device.verification_uri_complete}\n`,
			)
			print(`Enter code: ${device.user_code}\n`)

			openBrowser(device.verification_uri_complete)

			print('Waiting for authorization...')

			const token = yield* fromPromise(() =>
				pollDeviceToken(
					baseUrl,
					device.device_code,
					device.interval,
					device.expires_in,
				),
			)

			yield* fromPromise(() =>
				saveCredentials({ access_token: token, base_url: baseUrl }),
			)

			const session = yield* fromPromise(() => getSession(baseUrl, token))
			print(`Logged in as ${session.user.email}`)

			// Prompt for service selection after successful auth
			yield* promptServiceSelection(baseUrl, token, configPath, print)

			return 0
		}),
	)
}

export async function runLogout(print: (msg: string) => void): Promise<number> {
	return runEffect(
		Effect.gen(function* () {
			const had = yield* fromPromise(() => clearCredentials())
			print(had ? 'Logged out.' : 'No active session.')
			return 0
		}),
	)
}

export async function runWhoami(
	print: (value: unknown) => void,
	jsonMode = false,
): Promise<number> {
	return runEffect(
		Effect.gen(function* () {
			const creds = yield* fromPromise(() => loadCredentials())
			if (!creds) {
				const message =
					'Not logged in. Run `chkit obsessiondb login` to authenticate.'
				print(
					jsonMode
						? errorEnvelope('obsessiondb whoami', 'not_logged_in', message)
						: message,
				)
				return 1
			}

			return yield* Effect.gen(function* () {
				const session = yield* fromPromise(() =>
					getSession(creds.base_url, creds.access_token),
				)
				print(
					jsonMode
						? whoamiEnvelope({
								email: session.user.email,
								name: session.user.name,
							})
						: `Logged in as ${session.user.email} (${session.user.name})`,
				)
				return 0
			}).pipe(
				Effect.catchCause(() =>
					Effect.gen(function* () {
						yield* fromPromise(() => clearCredentials())
						const message =
							'Session expired. Run `chkit obsessiondb login` to re-authenticate.'
						print(
							jsonMode
								? errorEnvelope(
										'obsessiondb whoami',
										'session_expired',
										message,
									)
								: message,
						)
						return 1
					}),
				),
			)
		}),
	)
}
