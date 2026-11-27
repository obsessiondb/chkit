import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { assertInsertSettingsChangeable, insertSettingsOverrideWarning, mergeMigrationSettings, parseSettingFlags } from '../../../commands/migrate/settings.js'

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

  test('async_insert, wait_for_async_insert and profile are kept as written (#790)', () => {
    expect(parseSettingFlags(['async_insert=TRUE', 'wait_for_async_insert = 0', 'profile=bulk'])).toEqual({
      async_insert: 'TRUE',
      wait_for_async_insert: '0',
      profile: 'bulk',
    })
  })
})

describe('migrate --setting insert overrides warning (#790)', () => {
  test('values equal to chkit\'s defaults, in any spelling, warn about nothing', () => {
    expect(insertSettingsOverrideWarning(undefined)).toBeUndefined()
    expect(insertSettingsOverrideWarning({ max_threads: '1', profile: 'bulk' })).toBeUndefined()
    expect(insertSettingsOverrideWarning({ async_insert: 'FALSE', wait_for_async_insert: '1' })).toBeUndefined()
    expect(insertSettingsOverrideWarning({ async_insert: '0', wait_for_async_insert: 'true' })).toBeUndefined()
  })

  test('one line names each overridden setting as written, with the guarantee it turns off', () => {
    expect(insertSettingsOverrideWarning({ async_insert: 'True' })).toBe(
      'Warning: --setting overrides what every migration write sets by default: async_insert=True (an INSERT is queued as an asynchronous insert, which migrate cannot cancel).',
    )
    expect(insertSettingsOverrideWarning({ wait_for_async_insert: '0', async_insert: '1' })).toBe(
      'Warning: --setting overrides what every migration write sets by default: async_insert=1 (an INSERT is queued as an asynchronous insert, which migrate cannot cancel); wait_for_async_insert=0 (an asynchronous INSERT can be journaled as applied before its rows are stored).',
    )
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

  test('an override is checked as sent, and chkit\'s default as its journal writes send it', async () => {
    const fixedAt = (name: string, value: string) => changeable.map((row) => (row.name === name ? { name, value, readonly: 1 } : row))
    await assertInsertSettingsChangeable(executor(fixedAt('async_insert', '0')), { async_insert: 'false' })
    await expect(assertInsertSettingsChangeable(executor(fixedAt('async_insert', '0')), { async_insert: '1' })).rejects.toMatchObject({
      code: 'insert_settings_fixed',
      message: 'Setting async_insert is fixed at 0 for this ClickHouse user, so --setting async_insert=1 cannot apply. Nothing ran.',
    })
    await expect(assertInsertSettingsChangeable(executor(fixedAt('wait_for_async_insert', '0')), { wait_for_async_insert: 'false' })).rejects.toMatchObject({
      code: 'insert_settings_fixed',
      message: 'Setting wait_for_async_insert is fixed at 0 for this ClickHouse user, and chkit migrate needs wait_for_async_insert = 1 so that a statement it records as applied is stored. Nothing ran.',
    })
  })

  test('names the URL when a fixed setting prevents an override (#879)', async () => {
    const db = executor([{ name: 'async_insert', value: '0', readonly: 1 }])
    await expect(assertInsertSettingsChangeable(db, undefined, { async_insert: '1' })).rejects.toMatchObject({
      code: 'insert_settings_fixed',
      message: 'Setting async_insert is fixed at 0 for this ClickHouse user, so async_insert=1 from clickhouse.url cannot apply. Nothing ran.',
    })
  })
})

test('names the sources of effective insert overrides (#879)', () => {
  const asyncGuarantee = 'an INSERT is queued as an asynchronous insert, which migrate cannot cancel'
  const waitGuarantee = 'an asynchronous INSERT can be journaled as applied before its rows are stored'
  expect(insertSettingsOverrideWarning(undefined, { async_insert: '1' })).toBe(
    `Warning: clickhouse.url overrides what every migration write sets by default: async_insert=1 (${asyncGuarantee}).`,
  )
  expect(insertSettingsOverrideWarning({ async_insert: '1' }, { wait_for_async_insert: '0' })).toBe(
    `Warning: --setting and clickhouse.url override what every migration write sets by default: async_insert=1 from --setting (${asyncGuarantee}); wait_for_async_insert=0 from clickhouse.url (${waitGuarantee}).`,
  )
  expect(insertSettingsOverrideWarning({ async_insert: '0' }, { async_insert: '1' })).toBeUndefined()
})

test('merges URL insert settings underneath flags (#879)', () => {
  expect(mergeMigrationSettings({ async_insert: '0', profile: 'bulk' }, { async_insert: '1', wait_for_async_insert: '0' })).toEqual({
    async_insert: '0', wait_for_async_insert: '0', profile: 'bulk',
  })
  expect(mergeMigrationSettings(undefined, undefined)).toBeUndefined()
})
