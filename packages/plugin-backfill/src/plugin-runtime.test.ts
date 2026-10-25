import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import * as clickhouse from '@chkit/clickhouse'
import { resolveConfig } from '@chkit/core'
import { BackfillConfigError } from './errors.js'
import { PlanSchema } from './options.js'
import * as planner from './planner.js'
import { createBackfillPlugin } from './plugin.js'

afterEach(() => mock.restore())

test.each([
  { failure: new Error('planning failed'), exitCode: 1 },
  { failure: new BackfillConfigError('unsafe target'), exitCode: 2 },
])('owned planner executor closes once and retains error classification: $exitCode', async ({ failure, exitCode }) => {
  const close = mock(async () => {})
  spyOn(clickhouse, 'createClickHouseExecutor').mockReturnValue({
    async command() {},
    async query() {
      return []
    },
    async insert() {},
    async listSchemaObjects() {
      return []
    },
    async listTableDetails() {
      return []
    },
    async submit() {
      return ''
    },
    async queryStatus() {
      return { status: 'unknown' }
    },
    close,
  })
  spyOn(planner, 'buildBackfillPlan').mockRejectedValue(failure)
  const printed: unknown[] = []
  const command = createBackfillPlugin().commands.find((candidate) => candidate.name === 'plan')
  expect(command).toBeDefined()
  expect(
    await command?.run({
      args: [],
      flags: {},
      jsonMode: true,
      rawOptions: {},
      options: PlanSchema.parse({ target: 'app.events' }),
      config: resolveConfig({ schema: [], clickhouse: { url: 'http://localhost:8123' } }),
      configPath: '/fixture/clickhouse.config.ts',
      print: (value) => printed.push(value),
    }),
  ).toBe(exitCode)
  expect(close).toHaveBeenCalledTimes(1)
  expect(printed).toEqual([{ ok: false, command: 'plan', error: failure.message }])
})
