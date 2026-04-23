import type { Credentials } from '../auth/index.js'
import { createApiClient, type ApiClient } from '../client.js'
export { isSessionExpiredError } from '../api-request.js'

export type JobsClient = ApiClient['jobs']

export function createJobsClient(creds: Credentials): JobsClient {
  return createApiClient(creds).jobs
}
