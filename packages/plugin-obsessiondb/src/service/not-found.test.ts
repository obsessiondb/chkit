import { describe, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/client'

import { explainServiceNotFound, ServiceNotFoundError } from './not-found'
import type { ServiceOrganization } from './types'

const ORGANIZATIONS: ServiceOrganization[] = [
	organization('org-acme', 'Acme', ['prod']),
	organization('org-bench', 'Benchmarks', ['benchmarks']),
]

function organization(id: string, name: string, slugs: string[]): ServiceOrganization {
	return {
		id,
		name,
		slug: id,
		services: slugs.map((slug) => ({
			id: `svc-${slug}`,
			slug,
			name: slug,
			status: 'running' as const,
			tier: 1,
			nodes: 1,
			connectionUrl: null,
			connectionUsername: null,
			desiredStatus: 'running' as const,
			desiredTier: 1,
			desiredNodes: 1,
			createdAt: '2026-01-01T00:00:00.000Z',
			managed: true,
		})),
	}
}

function deps(activeOrganizationId: string | null) {
	return {
		listOrganizations: async () => ORGANIZATIONS,
		getActiveOrganizationId: async () => activeOrganizationId,
	}
}

const notFound = () => new ORPCError('NOT_FOUND', { status: 404 })

describe('explainServiceNotFound', () => {
	test('names the active and owning organization when the service is in another one', async () => {
		const result = await explainServiceNotFound(notFound(), 'benchmarks', deps('org-acme'))

		expect(result).toBeInstanceOf(ServiceNotFoundError)
		expect(result).toMatchObject({ code: 'service_not_in_active_organization' })
		const message = (result as ServiceNotFoundError).message
		expect(message).toContain('service "benchmarks" is not in the active organization "Acme"')
		expect(message).toContain('(it belongs to "Benchmarks")')
		expect(message).toContain('Select a service from "Acme" with `chkit obsessiondb service select`')
	})

	test('reports a service that no organization has', async () => {
		const result = await explainServiceNotFound(notFound(), 'gone', deps('org-acme'))

		expect(result).toMatchObject({
			code: 'service_not_found',
			message: expect.stringContaining(
				'service "gone" was not found in any organization you can access',
			),
		})
	})

	test('keeps the original error when the service is in the active organization', async () => {
		const error = notFound()
		expect(await explainServiceNotFound(error, 'prod', deps('org-acme'))).toBe(error)
	})

	test('keeps the original error when the session has no active organization', async () => {
		const error = notFound()
		expect(await explainServiceNotFound(error, 'benchmarks', deps(null))).toBe(error)
	})

	test('keeps an error that is not a NOT_FOUND without looking anything up', async () => {
		const error = new ORPCError('INTERNAL_SERVER_ERROR')
		let lookups = 0
		const result = await explainServiceNotFound(error, 'benchmarks', {
			listOrganizations: async () => {
				lookups += 1
				return ORGANIZATIONS
			},
			getActiveOrganizationId: async () => 'org-acme',
		})

		expect(result).toBe(error)
		expect(lookups).toBe(0)
	})

	test('keeps the original error when the lookup fails', async () => {
		const error = notFound()
		const result = await explainServiceNotFound(error, 'benchmarks', {
			listOrganizations: async () => {
				throw new Error('listAll failed')
			},
			getActiveOrganizationId: async () => 'org-acme',
		})

		expect(result).toBe(error)
	})
})
