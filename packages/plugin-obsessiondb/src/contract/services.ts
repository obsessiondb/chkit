/**
 * Copied from @obsessiondb/contract-console — will be replaced
 * by a direct dependency once the contract package is published.
 */
import { oc } from '@orpc/contract'
import { z } from 'zod'

export const serviceStatusSchema = z.enum([
  'provisioning',
  'running',
  'scaling',
  'stopping',
  'stopped',
  'starting',
  'terminating',
  'terminated',
  'error',
])

export const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: serviceStatusSchema,
  tier: z.number().int(),
  nodes: z.number().int(),
  connectionUrl: z.string().nullable(),
  connectionUsername: z.string().nullable(),
  desiredStatus: z.enum(['running', 'stopped', 'terminated']),
  desiredTier: z.number().int(),
  desiredNodes: z.number().int(),
  createdAt: z.string().datetime(),
  managed: z.boolean(),
})

export const servicesContract = {
  list: oc
    .input(z.object({}))
    .output(z.object({ services: z.array(serviceSchema) })),

  listAll: oc.input(z.object({})).output(
    z.object({
      organizations: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          services: z.array(serviceSchema),
        }),
      ),
    }),
  ),

  get: oc
    .input(z.object({ serviceId: z.string() }))
    .output(serviceSchema),
}
