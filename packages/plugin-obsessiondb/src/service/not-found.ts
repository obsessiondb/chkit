import { ORPCError } from '@orpc/client'

import type { ServiceOrganization } from './types.js'

/** Stable `--json` error codes for a selected service the console cannot find. */
type ServiceNotFoundCode =
	| 'service_not_in_active_organization'
	| 'service_not_found'

/** A console call for a service failed because the console could not find the service. */
export class ServiceNotFoundError extends Error {
	readonly code: ServiceNotFoundCode

	constructor(code: ServiceNotFoundCode, message: string) {
		super(message)
		this.name = 'ServiceNotFoundError'
		this.code = code
	}
}

interface ServiceLookupDeps {
	listOrganizations: () => Promise<ServiceOrganization[]>
	getActiveOrganizationId: () => Promise<string | null>
}

/**
 * The console looks a service slug up in the session's active organization only,
 * so a call for a service of another organization fails with a bare NOT_FOUND.
 * Returns an error that names the service, the active organization and the
 * organization that owns the service, or `error` itself when it is not a
 * NOT_FOUND or the lookup cannot explain it.
 */
export async function explainServiceNotFound(
	error: unknown,
	serviceSlug: string,
	deps: ServiceLookupDeps,
): Promise<unknown> {
	if (!(error instanceof ORPCError) || error.code !== 'NOT_FOUND') return error

	const lookup = await lookUpOrganizations(deps)
	if (!lookup) return error
	const { organizations, activeOrganizationId } = lookup

	const owners = organizations.filter((org) =>
		org.services.some((service) => service.slug === serviceSlug),
	)
	if (owners.length === 0) {
		return new ServiceNotFoundError(
			'service_not_found',
			`obsessiondb: service "${serviceSlug}" was not found in any organization you can access. It may have been deleted, or you may no longer have access to it. Select another service with \`chkit obsessiondb service select\`.`,
		)
	}

	// Without an active organization the console searches every organization;
	// with the service in the active one, the NOT_FOUND has another cause.
	if (!activeOrganizationId) return error
	if (owners.some((org) => org.id === activeOrganizationId)) return error

	const active = organizations.find((org) => org.id === activeOrganizationId)
	const activeLabel = active ? `"${active.name}"` : `"${activeOrganizationId}"`
	const ownerLabel = owners.map((org) => `"${org.name}"`).join(', ')
	return new ServiceNotFoundError(
		'service_not_in_active_organization',
		`obsessiondb: service "${serviceSlug}" is not in the active organization ${activeLabel} of this chkit session (it belongs to ${ownerLabel}). The ObsessionDB console only finds services in the session's active organization, and switching organizations in the console does not change the chkit session's. Select a service from ${activeLabel} with \`chkit obsessiondb service select\`.`,
	)
}

async function lookUpOrganizations(deps: ServiceLookupDeps): Promise<
	| { organizations: ServiceOrganization[]; activeOrganizationId: string | null }
	| undefined
> {
	try {
		const [organizations, activeOrganizationId] = await Promise.all([
			deps.listOrganizations(),
			deps.getActiveOrganizationId(),
		])
		return { organizations, activeOrganizationId }
	} catch {
		// The original NOT_FOUND is more useful than a failure of the lookup.
		return undefined
	}
}
