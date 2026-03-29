import type { Credentials } from '../auth/index.js'
import { apiRequest } from '../api-request.js'
import type { Service } from './types.js'

export async function listServices(creds: Credentials): Promise<Service[]> {
  const res = await apiRequest<{ services: Service[] }>('/api/v1/services', creds)
  return res.services
}
