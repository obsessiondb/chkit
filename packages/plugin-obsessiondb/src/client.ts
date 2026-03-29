import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { SessionExpiredError } from './api-request.js'
import type { Credentials } from './auth/index.js'
import { servicesContract, jobsContract, workbenchContract } from './contract/index.js'

const contract = {
  services: servicesContract,
  jobs: jobsContract,
  workbench: workbenchContract,
}

export type ApiClient = ContractRouterClient<typeof contract>

export function createApiClient(creds: Credentials): ApiClient {
  const link = new RPCLink({
    url: `${creds.base_url}/rpc`,
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
