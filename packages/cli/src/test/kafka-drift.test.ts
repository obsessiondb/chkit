import { expect, test } from 'bun:test'
import { table } from '@chkit/core'
import { compareTableShape } from '../commands/drift/compare.js'

test('Kafka drift compares decoded setting literals, preserving significant string whitespace', () => {
  const expected = table({
    database: 'app',
    name: 'q',
    engine: 'Kafka',
    columns: [{ name: 'id', type: 'String' }],
    settings: { kafka_client_id: 'a  b', kafka_commit_on_select: false, kafka_num_consumers: 1 },
  })
  const actual = {
    engine: 'Kafka()',
    columns: expected.columns,
    indexes: [],
    projections: [],
    settings: { kafka_client_id: "'a  b'", kafka_commit_on_select: '0', kafka_num_consumers: '1' },
  }
  expect(compareTableShape(expected, actual)).toBeNull()
  expect(
    compareTableShape(expected, {
      ...actual,
      settings: { ...actual.settings, kafka_client_id: "'a b'" },
    })?.settingDiffs,
  ).toEqual(['kafka_client_id'])
})
