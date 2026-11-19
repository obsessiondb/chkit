import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { assertInsertSettingsChangeable, parseSettingFlags } from '../../../commands/migrate/settings.js'

describe('migrate --setting parsing (#321)', () => {
  test('no --setting yields no settings', () => {
    expect(parseSettingFlags(undefined)).toBeUndefined()
    expect(parseSettingFlags([])).toBeUndefined()
  })

  test('name=value pairs become query settings', () => {
    expect(parseSettingFlags(['max_table_size_to_drop=0', ' max_partition_size_to_drop = 0 '])).toEqual({
      max_table_size_to_drop: '0',
      max_partition_size_to_drop: '0',
    })
  })

  test('a value keeps any further = signs', () => {
    expect(parseSettingFlags(['log_comment=a=b'])).toEqual({ log_comment: 'a=b' })
  })

  test('rejects an entry without a setting name', () => {
    for (const entry of ['max_table_size_to_drop', '=0', 'bad-name=0']) {
      expect(() => parseSettingFlags([entry])).toThrow(`--setting expects <name>=<value>`)
    }
  })

  test('rejects HTTP parameters that would retarget the statement (#353)', () => {
    for (const name of ['query', 'database', 'query_id', 'session_id', 'session_check', 'session_timeout', 'user', 'password']) {
      expect(() => parseSettingFlags(['max_table_size_to_drop=0', `${name}=secret`])).toThrow(
        `--setting ${name} is not allowed: ${name} is a ClickHouse HTTP parameter, not a query setting.`,
      )
    }
  })

  test('async inserts may only stay off and waited for (#790)', () => {
    expect(parseSettingFlags(['async_insert=0', ' async_insert = FALSE '])).toEqual({ async_insert: '0' })
    expect(parseSettingFlags(['wait_for_async_insert=True'])).toEqual({ wait_for_async_insert: '1' })
    const refused = [
      ...['1', 'true', 'True', '2', ''].map((value) => `async_insert=${value}`),
      ...['0', 'false', ''].map((value) => `wait_for_async_insert=${value}`),
      'profile=bulk',
    ]
    for (const entry of refused) {
      expect(() => parseSettingFlags(['max_threads=1', entry])).toThrow(
        `--setting ${entry} is not allowed: migrate would record an asynchronous INSERT as applied while its rows may still be buffered. Nothing ran.`,
      )
    }
  })
})

describe('migrate refuses a user whose insert settings are fixed (#790)', () => {
  const executor = (rows: Array<{ name: string; value: string; readonly: number }>) =>
    ({ query: async () => rows }) as unknown as ClickHouseExecutor
  const changeable = [
    { name: 'readonly', value: '0', readonly: 0 },
    { name: 'async_insert', value: '1', readonly: 0 },
    { name: 'wait_for_async_insert', value: '0', readonly: 0 },
  ]

  test('changeable settings, settings already at chkit\'s values, or a readonly = 1 user pass', async () => {
    await assertInsertSettingsChangeable(executor(changeable))
    await assertInsertSettingsChangeable(executor([{ name: 'async_insert', value: '0', readonly: 1 }, { name: 'wait_for_async_insert', value: '1', readonly: 1 }]))
    await assertInsertSettingsChangeable(executor([{ name: 'readonly', value: '1', readonly: 1 }, { name: 'async_insert', value: '1', readonly: 1 }]))
  })

  test('a failed read stops the run, unless the database does not exist yet', async () => {
    const failing = (error: Error) => ({ query: async () => { throw error } }) as unknown as ClickHouseExecutor
    await expect(assertInsertSettingsChangeable(failing(new Error('denied')))).rejects.toThrow('denied')
    await assertInsertSettingsChangeable(failing(Object.assign(new Error('UNKNOWN_DATABASE'), { code: '81' })))
  })

  for (const [name, value, durable] of [['async_insert', '1', '0'], ['wait_for_async_insert', '0', '1']] as const) {
    test(`${name} fixed at ${value} is refused with insert_settings_fixed`, async () => {
      const rows = changeable.map((row) => (row.name === name ? { name, value, readonly: 1 } : row))
      await expect(assertInsertSettingsChangeable(executor(rows))).rejects.toMatchObject({
        code: 'insert_settings_fixed',
        message: `Setting ${name} is fixed at ${value} for this ClickHouse user, and chkit migrate needs ${name} = ${durable} so that a statement it records as applied is stored. Nothing ran.`,
      })
    })
  }
})
