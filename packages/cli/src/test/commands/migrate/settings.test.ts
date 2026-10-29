import { describe, expect, test } from 'bun:test'

import { parseSettingFlags } from '../../../commands/migrate/settings.js'

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
})
