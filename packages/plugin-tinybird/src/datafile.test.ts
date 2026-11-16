import { describe, expect, test } from 'bun:test'

import { DatafileSyntaxError, parseDatafile, shellTokens, unquote } from './datafile.js'

describe('parseDatafile', () => {
  test('reads datasource commands and blocks', () => {
    const file = parseDatafile(
      'datasources/events.datasource',
      [
        'DESCRIPTION >',
        '    Raw events.',
        '',
        'TOKEN "reader" READ',
        'SCHEMA >',
        '    `id` UInt64 `json:$.id`,',
        '    `ts` DateTime',
        '',
        'INDEXES >',
        '    idx id TYPE minmax GRANULARITY 1',
        '',
        'ENGINE "MergeTree"',
        'ENGINE_SORTING_KEY "id, ts" # a comment',
        "ENGINE_SETTINGS \"index_granularity = 1024, storage_policy = 'hot'\"",
        '',
      ].join('\n')
    )
    expect(file.kind).toBe('datasource')
    expect(file.name).toBe('events')
    expect(file.description).toBe('Raw events.')
    expect(file.blocks.get('SCHEMA')).toBe('    `id` UInt64 `json:$.id`,\n    `ts` DateTime\n')
    expect(file.blocks.get('INDEXES')).toBe('    idx id TYPE minmax GRANULARITY 1\n')
    expect(file.vars.get('ENGINE')).toBe('MergeTree')
    expect(file.vars.get('ENGINE_SORTING_KEY')).toBe('id, ts')
    expect(file.vars.get('ENGINE_SETTINGS')).toBe("index_granularity = 1024, storage_policy = 'hot'")
  })

  test('attaches pipe commands to the current node and dedents SQL', () => {
    const file = parseDatafile(
      'pipes/agg.pipe',
      [
        'DESCRIPTION >',
        '    The pipe.',
        '',
        'NODE first',
        'DESCRIPTION >',
        '    The first node.',
        'SQL >',
        '',
        '    SELECT a,',
        '        b',
        '    FROM t',
        '',
        '',
        'NODE second',
        'SQL >',
        '    %',
        '    SELECT * FROM first',
        '',
        'TYPE materialized',
        'DATASOURCE target',
      ].join('\n')
    )
    expect(file.description).toBe('The pipe.')
    expect(file.nodes.map((node) => node.name)).toEqual(['first', 'second'])
    expect(file.nodes[0]?.description).toBe('The first node.')
    expect(file.nodes[0]?.sql).toBe('SELECT a,\n    b\nFROM t')
    expect(file.nodes[1]?.sql).toBe('%\n    SELECT * FROM first')
    expect(file.nodes[1]?.vars.get('TYPE')).toBe('materialized')
    expect(file.nodes[1]?.vars.get('DATASOURCE')).toBe('target')
  })

  test('keeps indented and non-command lines inside a block, drops comment-only lines', () => {
    const file = parseDatafile(
      'p.pipe',
      ['NODE n', 'SQL >', '    SELECT 1', 'FROM t', '    # dropped by Tinybird', '    TYPE x', 'TYPE endpoint'].join('\n')
    )
    expect(file.nodes[0]?.sql).toBe('    SELECT 1\nFROM t\n    TYPE x')
    expect(file.nodes[0]?.vars.get('TYPE')).toBe('endpoint')
  })

  test('rejects commands Tinybird rejects', () => {
    expect(() => parseDatafile('x.datasource', 'SETTINGS a = 1')).toThrow(DatafileSyntaxError)
    expect(() => parseDatafile('x.datasource', 'WHATEVER 1')).toThrow('WHATEVER is not a valid option in datasource files')
    expect(() => parseDatafile('x.pipe', 'TYPE copy')).toThrow('must come after a NODE')
  })

  test('records INCLUDE, which it does not evaluate; VERSION is a no-op as in the Forward CLI', () => {
    const file = parseDatafile('x.datasource', 'INCLUDE "shared.incl"\nVERSION 2')
    expect(file.unsupported).toEqual([{ command: 'INCLUDE', line: 1 }])
  })
})

describe('shellTokens', () => {
  test('splits like non-POSIX shlex', () => {
    expect(shellTokens('ENGINE_SORTING_KEY "a, b" # c')).toEqual(['ENGINE_SORTING_KEY', '"a, b"'])
    expect(shellTokens('ENGINE_TTL a#b c')).toEqual(['ENGINE_TTL', 'a'])
    expect(shellTokens('COPY_SCHEDULE */5 * * * *')).toEqual(['COPY_SCHEDULE', '*/5', '*', '*', '*', '*'])
    expect(shellTokens(`X "a"b" c`)).toEqual(['X', '"a"', 'b"', 'c'])
    expect(shellTokens("A it's")).toEqual(['A', "it's"])
    expect(shellTokens('   ')).toEqual([])
  })

  test('keeps a line with an unclosed quote as one token', () => {
    expect(shellTokens('X "unclosed')).toEqual(['X "unclosed'])
  })
})

describe('unquote', () => {
  test('drops one pair of surrounding quotes', () => {
    expect(unquote('"a"')).toBe('a')
    expect(unquote("'a'")).toBe('a')
    expect(unquote('a')).toBe('a')
    expect(unquote('"')).toBe('"')
  })
})
