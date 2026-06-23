/**
 * Copied from @obsessiondb/contract-console — will be replaced
 * by a direct dependency once the contract package is published.
 *
 * Source: obdb-platform packages/contract-console/src/contracts/services.ts
 * Commit: 0b98b51 (2026-06-23)
 * Subset lifted: list, listAll, get, instanceClaimStatus, claimInstance, revealCredentials.
 */
import { oc } from '@orpc/contract'
import { z } from 'zod'

const serviceStatusSchema = z.enum([
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

const RESERVED_SLUGS = ['new', 'settings', 'select', 'members', 'profile'] as const

const serviceSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/)
  .refine((s) => !RESERVED_SLUGS.includes(s as (typeof RESERVED_SLUGS)[number]), {
    message: 'Reserved slug',
  })

export const serviceSchema = z.object({
  id: z.string(),
  slug: serviceSlugSchema,
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
    .input(z.object({ serviceSlug: serviceSlugSchema }))
    .output(serviceSchema),

  instanceClaimStatus: oc.input(z.object({})).output(
    z.discriminatedUnion('eligible', [
      z.object({ eligible: z.literal(true) }),
      z.object({ eligible: z.literal(false), claimedOrganizationName: z.string() }),
    ]),
  ),

  claimInstance: oc
    .input(z.object({ organizationId: z.string().optional() }))
    .output(
      z.discriminatedUnion('outcome', [
        z.object({ outcome: z.literal('claimed'), id: z.string(), slug: serviceSlugSchema }),
        z.object({ outcome: z.literal('none_available') }),
        z.object({ outcome: z.literal('already_claimed'), claimedOrganizationName: z.string() }),
      ]),
    ),

  revealCredentials: oc
    .input(z.object({ serviceSlug: serviceSlugSchema }))
    .output(z.object({ password: z.string() })),
}
