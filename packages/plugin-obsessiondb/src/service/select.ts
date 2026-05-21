import { createInterface } from 'node:readline/promises'

import type { SelectedService, Service, ServiceOrganization } from './types.js'

export interface ServiceChoice {
	organization: ServiceOrganization
	service: Service
}

function organizationLabel(org: ServiceOrganization): string {
	return org.slug && org.slug !== org.name
		? `${org.name} (${org.slug})`
		: org.name
}

export function serviceChoiceLabel(choice: ServiceChoice): string {
	return `${organizationLabel(choice.organization)} / ${choice.service.name}`
}

function serviceChoices(organizations: ServiceOrganization[]): ServiceChoice[] {
	return organizations.flatMap((organization) =>
		organization.services.map((service) => ({ organization, service })),
	)
}

export function renderServiceOrganizations(
	organizations: ServiceOrganization[],
	selected?: SelectedService | null,
): string[] {
	const choices = serviceChoices(organizations)
	if (choices.length === 0) return ['No services found.']

	const lines = ['Services:']
	for (const org of organizations) {
		if (org.services.length === 0) continue
		lines.push(`${organizationLabel(org)}:`)
		for (const service of org.services) {
			const suffix =
				selected?.service_id === service.id ||
				selected?.service_name === service.name
					? ' [default]'
					: ''
			lines.push(`  - ${service.name} (${service.status})${suffix}`)
		}
	}
	return lines
}

export async function selectServiceInteractive(
	organizations: ServiceOrganization[],
	print: (msg: string) => void,
): Promise<ServiceChoice | null> {
	const choices = serviceChoices(organizations)
	if (choices.length === 0) {
		print('No services found.')
		return null
	}

	const [onlyChoice] = choices
	if (choices.length === 1 && onlyChoice) {
		print(
			`Auto-selected service: ${serviceChoiceLabel(onlyChoice)} (${onlyChoice.service.status})`,
		)
		return onlyChoice
	}

	print('\nAvailable services:')
	let choiceNumber = 1
	for (const org of organizations) {
		if (org.services.length === 0) continue
		print(`${organizationLabel(org)}:`)
		for (const service of org.services) {
			print(`  ${choiceNumber}. ${service.name} (${service.status})`)
			choiceNumber += 1
		}
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout })
	try {
		const answer = await rl.question(`\nSelect service [1-${choices.length}]: `)
		const index = parseInt(answer.trim(), 10) - 1
		const choice = choices[index]
		if (Number.isNaN(index) || !choice) {
			print('Invalid selection.')
			return null
		}
		return choice
	} finally {
		rl.close()
	}
}
