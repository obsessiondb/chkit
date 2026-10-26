import { createRequire } from 'node:module'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { SessionExpiredError } from './api-request.js'
import { getSession } from './auth/api-client.js'
import type { Credentials } from './auth/index.js'
import { servicesContract, jobsContract, workbenchContract } from './contract/index.js'
import { explainServiceNotFound } from './service/not-found.js'

const contract = {
  services: servicesContract,
  jobs: jobsContract,
  workbench: workbenchContract,
}

const pkg = createRequire(import.meta.url)('../package.json') as { version: string }

/**
 * Identifies CLI traffic to the ObsessionDB API. The API forwards this header to
 * ClickHouse so chkit queries are attributable in `system.query_log.http_user_agent`.
 * Versioned to match the direct-ClickHouse executor, which reports `chkit/<version>`.
 */
const USER_AGENT = `chkit/${pkg.version}`

export type ApiClient = ContractRouterClient<typeof contract>

export function createApiClient(creds: Credentials): ApiClient {
  const link = new RPCLink({
    url: `${creds.base_url}/rpc`,
    headers: () => ({
      Authorization: `Bearer ${creds.access_token}`,
      'User-Agent': USER_AGENT,
    }),
    fetch: async (input, init) => {
      const res = await globalThis.fetch(input, init)
      if (res.status === 401) {
        throw new SessionExpiredError()
      }
      return res
    },
    interceptors: [
      // Every call for a service (workbench queries, job submit and list) passes
      // here, so query, migrate, pull and backfill all explain a NOT_FOUND for a
      // service of another organization.
      async ({ input, next }) => {
        try {
          return await next()
        } catch (error) {
          const serviceSlug = serviceSlugOf(input)
          if (!serviceSlug) throw error
          throw await explainServiceNotFound(error, serviceSlug, {
            listOrganizations: async () => (await client.services.listAll({})).organizations,
            getActiveOrganizationId: async () => {
              const session = await getSession(creds.base_url, creds.access_token)
              return session.session?.activeOrganizationId ?? null
            },
          })
        }
      },
    ],
  })

  const client: ApiClient = createORPCClient(link)
  return client
}

function serviceSlugOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('serviceSlug' in input)) return undefined
  return typeof input.serviceSlug === 'string' ? input.serviceSlug : undefined
}
