import { expect, test } from 'bun:test'
import { parseKafkaSettings } from '@chkit/core'
import {
  parseEngineFromCreateTableQuery,
  parseSettingsFromCreateTableQuery,
} from './create-table-parser.js'

test('parses Kafka settings containing SQL keywords, semicolons, quotes and trailing backslashes', () => {
  const sql = String.raw`CREATE TABLE q (id String) ENGINE = Kafka SETTINGS kafka_broker_list = 'a:9092,b:9092', kafka_client_id = 'a; SETTINGS COMMENT ''b'' \\', kafka_num_consumers = 1 COMMENT 'queue';`
  expect(parseEngineFromCreateTableQuery(sql)).toBe('Kafka')
  expect(parseKafkaSettings(parseSettingsFromCreateTableQuery(sql))).toEqual({
    kafka_broker_list: 'a:9092,b:9092',
    kafka_client_id: "a; SETTINGS COMMENT 'b' \\",
    kafka_num_consumers: 1,
  })
})

test('engine arguments preserve spaces and quoted clause keywords', () => {
  const engine = "Kafka('host:9092', 'SETTINGS; COMMENT', 'a  b', 'JSONEachRow')"
  const sql = `CREATE TABLE q (id String) ENGINE = ${engine} SETTINGS kafka_num_consumers = 1;`
  expect(parseEngineFromCreateTableQuery(sql)).toBe(engine)
  expect(parseSettingsFromCreateTableQuery(sql)).toEqual({ kafka_num_consumers: '1' })
})
