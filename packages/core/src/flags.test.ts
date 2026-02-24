import { describe, expect, it } from 'bun:test'

import { defineFlags, MissingFlagValueError, UnknownFlagError, parseFlags, type FlagDef } from './flags.js'

describe('parseFlags', () => {
  const defs: FlagDef[] = [
    { name: '--name', type: 'string', description: 'Migration name', placeholder: '<name>' },
    { name: '--dryrun', type: 'boolean', description: 'Dry run' },
    { name: '--json', type: 'boolean', description: 'JSON output' },
    { name: '--database', type: 'string[]', description: 'Databases' },
    { name: '--emit-zod', type: 'boolean', description: 'Emit Zod', negation: true },
  ]

  it('parses string flags', () => {
    const result = parseFlags(['--name', 'my-migration'], defs)
    expect(result['--name']).toBe('my-migration')
  })

  it('parses boolean flags', () => {
    const result = parseFlags(['--dryrun', '--json'], defs)
    expect(result['--dryrun']).toBe(true)
    expect(result['--json']).toBe(true)
  })

  it('parses string[] flags with comma splitting', () => {
    const result = parseFlags(['--database', 'db1,db2'], defs)
    expect(result['--database']).toEqual(['db1', 'db2'])
  })

  it('accumulates repeated string[] flags', () => {
    const result = parseFlags(['--database', 'db1', '--database', 'db2,db3'], defs)
    expect(result['--database']).toEqual(['db1', 'db2', 'db3'])
  })

  it('parses negation flags', () => {
    const result = parseFlags(['--no-emit-zod'], defs)
    expect(result['--emit-zod']).toBe(false)
  })

  it('positive overrides negation', () => {
    const result = parseFlags(['--no-emit-zod', '--emit-zod'], defs)
    expect(result['--emit-zod']).toBe(true)
  })

  it('returns empty for no flags', () => {
    const result = parseFlags([], defs)
    expect(result).toEqual({})
  })

  it('ignores positional args', () => {
    const result = parseFlags(['generate', '--name', 'foo', 'extra'], defs)
    expect(result['--name']).toBe('foo')
  })

  it('throws UnknownFlagError for unknown flags', () => {
    expect(() => parseFlags(['--typo'], defs)).toThrow(UnknownFlagError)
  })

  it('throws MissingFlagValueError for string flag without value', () => {
    expect(() => parseFlags(['--name'], defs)).toThrow(MissingFlagValueError)
  })

  it('throws MissingFlagValueError when next token is a flag', () => {
    expect(() => parseFlags(['--name', '--dryrun'], defs)).toThrow(MissingFlagValueError)
  })

  it('handles mixed flags and positionals', () => {
    const result = parseFlags(['generate', '--dryrun', '--name', 'test', '--database', 'a,b'], defs)
    expect(result['--dryrun']).toBe(true)
    expect(result['--name']).toBe('test')
    expect(result['--database']).toEqual(['a', 'b'])
  })

  it('last string flag wins', () => {
    const result = parseFlags(['--name', 'first', '--name', 'second'], defs)
    expect(result['--name']).toBe('second')
  })

  it('infers typed record from defineFlags', () => {
    const typedDefs = defineFlags([
      { name: '--out', type: 'string', description: 'Output' },
      { name: '--verbose', type: 'boolean', description: 'Verbose' },
      { name: '--tags', type: 'string[]', description: 'Tags' },
    ] as const)

    const result = parseFlags(['--out', 'file.ts', '--verbose', '--tags', 'a,b'], typedDefs)

    // Runtime assertions
    expect(result['--out']).toBe('file.ts')
    expect(result['--verbose']).toBe(true)
    expect(result['--tags']).toEqual(['a', 'b'])

    // Type-level assertions: these assignments would fail to compile if inference is broken
    const _out: string | undefined = result['--out']
    const _verbose: boolean | undefined = result['--verbose']
    const _tags: string[] | undefined = result['--tags']
    void _out
    void _verbose
    void _tags
  })
})
