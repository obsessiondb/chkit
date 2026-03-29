import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { Credentials } from '../auth/index.js'
import { jobsContract } from './contract.js'

export type JobsClient = ContractRouterClient<typeof jobsContract>

export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired. Run `chkit obsessiondb login` to re-authenticate.')
  }
}

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof SessionExpiredError
}

export function createJobsClient(creds: Credentials): JobsClient {
  const link = new RPCLink({
    url: `${creds.base_url}/rpc/jobs`,
    headers: () => ({
      Authorization: `Bearer ${creds.access_token}`,
      'User-Agent': 'chkit-cli',
    }),
    fetch: async (input, init) => {
      const res = await globalThis.fetch(input, init)
      if (res.status === 401) {
        throw new SessionExpiredError()
      }
      return res
    },
  })

  return createORPCClient(link)
}
