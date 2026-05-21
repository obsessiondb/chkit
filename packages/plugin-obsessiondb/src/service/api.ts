import type { Credentials } from '../auth/index.js'
import { createApiClient } from '../client.js'
import type { Service, ServiceOrganization } from './types.js'

export async function listServiceOrganizations(
	creds: Credentials,
): Promise<ServiceOrganization[]> {
	const client = createApiClient(creds)
	const res = await client.services.listAll({})
	return res.organizations
}

export async function listServices(creds: Credentials): Promise<Service[]> {
	const organizations = await listServiceOrganizations(creds)
	return organizations.flatMap((org) => org.services)
}
