import { describe, expect, test } from 'bun:test'

import type { BackfillPlanState } from '@chkit/plugin-backfill/sdk'

import { buildSubmitTasks, parseSubmitInput } from './submit'

function makePlan(requireIdempotencyToken = true): BackfillPlanState {
	return {
		planId: 'abcdef0123456789',
		target: 'app.events',
		createdAt: '2026-06-30T00:00:00.000Z',
		from: '2026-01-01T00:00:00.000Z',
		to: '2026-02-01T00:00:00.000Z',
		chunkPlan: {
			planId: 'abcdef0123456789',
			generatedAt: '2026-06-30T00:00:00.000Z',
			rowProbeStrategy: 'count',
			targetChunkBytes: 1000,
			table: {
				database: 'app',
				table: 'events',
				sortKeys: [
					{ name: 'id', type: 'UInt64', category: 'numeric', boundaryEncoding: 'literal' },
				],
			},
			partitions: [],
			chunks: [
				{
					id: 'c1',
					partitionId: 'p0',
					ranges: [{ dimensionIndex: 0, from: '0', to: '100' }],
					estimate: {
						rows: 100,
						bytesCompressed: 1000,
						bytesUncompressed: 3000,
						confidence: 'high',
						reason: 'partition-metadata',
					},
					analysis: { lineage: [] },
				},
				{
					id: 'c2',
					partitionId: 'p1',
					ranges: [],
					estimate: {
						rows: 50,
						bytesCompressed: 500,
						bytesUncompressed: 1500,
						confidence: 'high',
						reason: 'partition-metadata',
					},
					analysis: { lineage: [] },
				},
			],
			totalRows: 150,
			totalBytesCompressed: 1500,
			totalBytesUncompressed: 4500,
			stats: {
				totalPartitions: 2,
				oversizedPartitions: 0,
				focusedChunks: 0,
				totalChunks: 2,
				avgChunkBytes: 750,
				maxChunkBytes: 1000,
				minChunkBytes: 500,
			},
		},
		execution: { mode: 'copy', sourceTarget: 'app.events', requireIdempotencyToken },
		options: { maxParallelChunks: 1, maxRetriesPerChunk: 5, requireIdempotencyToken },
		policy: {
			requireDryRunBeforeRun: true,
			requireExplicitWindow: true,
			blockOverlappingRuns: true,
			failCheckOnRequiredPendingBackfill: true,
		},
		limits: { maxWindowHours: 720, minChunkMinutes: 15 },
	}
}

describe('buildSubmitTasks', () => {
	test('produces one task per chunk, preserving ids', () => {
		const tasks = buildSubmitTasks(makePlan())
		expect(tasks.map((t) => t.id)).toEqual(['c1', 'c2'])
	})

	test('renders the same INSERT … SELECT the local executor would run', () => {
		const [first] = buildSubmitTasks(makePlan())
		expect(first?.sql).toContain('INSERT INTO app.events')
		expect(first?.sql).toContain('FROM app.events')
		expect(first?.sql).toContain("_partition_id = 'p0'")
		expect(first?.sql).toContain('id >= ')
	})

	test('carries estimates, group, and retry budget onto each task', () => {
		const [first] = buildSubmitTasks(makePlan())
		expect(first?.group).toBe('p0')
		expect(first?.estimatedBytes).toBe(1000)
		expect(first?.estimatedBytesUncompressed).toBe(3000)
		expect(first?.maxRetries).toBe(5)
	})

	test('includes an idempotency token when required', () => {
		const [first] = buildSubmitTasks(makePlan(true))
		expect(first?.sql).toContain('insert_deduplication_token=')
	})

	test('omits the idempotency token when not required', () => {
		const [first] = buildSubmitTasks(makePlan(false))
		expect(first?.sql).not.toContain('insert_deduplication_token=')
	})

	test('replays every MV via UNION ALL for an mv_replay plan', () => {
		const plan = makePlan()
		plan.execution = {
			mode: 'mv_replay',
			sourceTarget: 'app.events',
			mvReplayQueries: [
				'SELECT id FROM app.web_events',
				'SELECT id FROM app.api_events',
			],
			targetColumns: ['id'],
			requireIdempotencyToken: true,
		}

		const [first] = buildSubmitTasks(plan)
		expect(first?.sql.match(/INSERT INTO app\.events/g)).toHaveLength(1)
		expect(first?.sql).toContain('FROM app.web_events')
		expect(first?.sql).toContain('FROM app.api_events')
		expect(first?.sql.match(/UNION ALL/g)).toHaveLength(1)
	})
})

describe('parseSubmitInput', () => {
	test('parses a valid target', () => {
		const { opts } = parseSubmitInput({ '--target': 'app.events' })
		expect(opts.target).toBe('app.events')
	})

	test('throws when target is missing', () => {
		expect(() => parseSubmitInput({})).toThrow('--target')
	})

	test('throws when target is not database.table', () => {
		expect(() => parseSubmitInput({ '--target': 'events' })).toThrow('--target')
	})

	test('coerces a byte-size suffix', () => {
		const { opts } = parseSubmitInput({ '--target': 'app.events', '--max-chunk-bytes': '500M' })
		expect(opts.maxChunkBytes).toBe(500 * 1024 ** 2)
	})

	test('normalizes from/to timestamps to ISO', () => {
		const { opts } = parseSubmitInput({
			'--target': 'app.events',
			'--from': '2026-01-01',
		})
		expect(opts.from).toBe('2026-01-01T00:00:00.000Z')
	})

	test('throws on an invalid timestamp', () => {
		expect(() =>
			parseSubmitInput({ '--target': 'app.events', '--from': 'not-a-date' }),
		).toThrow('--from')
	})

	test('accepts a valid concurrency', () => {
		const { concurrency } = parseSubmitInput({ '--target': 'app.events', '--concurrency': '4' })
		expect(concurrency).toBe(4)
	})

	test('rejects an out-of-range concurrency', () => {
		expect(() =>
			parseSubmitInput({ '--target': 'app.events', '--concurrency': '100' }),
		).toThrow('--concurrency')
	})

	test('passes through a title', () => {
		const { title } = parseSubmitInput({ '--target': 'app.events', '--title': 'My backfill' })
		expect(title).toBe('My backfill')
	})
})
