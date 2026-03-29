import type { Credentials } from '../auth/index.js'
import { createApiClient } from '../client.js'
import type { Service } from './types.js'

export async function listServices(creds: Credentials): Promise<Service[]> {
  const client = createApiClient(creds)
  const res = await client.services.listAll({})
  return res.organizations.flatMap((org) => org.services)
}
