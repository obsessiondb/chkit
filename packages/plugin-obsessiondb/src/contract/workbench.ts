/**
 * Copied from @obsessiondb/feature-workbench-contract — will be replaced
 * by a direct dependency once the contract package is published.
 */
import { oc } from '@orpc/contract'
import { z } from 'zod'

const queryColumnMetaSchema = z.object({
	name: z.string(),
	type: z.string(),
})

const queryResultSchema = z.object({
	data: z.array(z.array(z.string().nullable())),
	meta: z.array(queryColumnMetaSchema),
	rows: z.number().int(),
	statistics: z
		.object({
			bytes_read: z.number().int().optional(),
			rows_read: z.number().int().optional(),
			elapsed: z.number().optional(),
		})
		.optional(),
	query_id: z.string().optional(),
	message: z.string().optional(),
	error: z.string().optional(),
})

export const workbenchContract = {
	query: {
		execute: oc
			.input(
				z.object({
					serviceSlug: z.string(),
					query: z.string().min(1),
					settings: z
						.record(z.string(), z.union([z.string(), z.number()]))
						.optional(),
					database: z.string().optional(),
				}),
			)
			.output(queryResultSchema),
	},
}
