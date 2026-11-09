import { describe, expect, it } from 'bun:test'

import { defineFlags, expandShortFlags, MissingFlagValueError, UnknownFlagError, parseFlags, type FlagDef } from './flags.js'

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

  it('throws UnknownFlagError for short flags instead of skipping them (#491)', () => {
    expect(() => parseFlags(['-t', 'alpha', '--dryrun'], defs)).toThrow('Unknown flag: -t')
    expect(() => parseFlags(['--dryrun', '-c', 'x.ts'], defs)).toThrow('Unknown flag: -c')
    expect(() => parseFlags(['-t=alpha'], defs)).toThrow('Unknown flag: -t')
    expect(() => parseFlags(['-5'], defs)).toThrow('Unknown flag: -5')
    expect(() => parseFlags(['-v'], defs)).toThrow(UnknownFlagError)
  })

  it('keeps values that start with a dash and a bare dash', () => {
    expect(parseFlags(['--name', '-5'], defs)['--name']).toBe('-5')
    expect(parseFlags(['--name', '-t'], defs)['--name']).toBe('-t')
    expect(parseFlags(['--database', '-1,-2'], defs)['--database']).toEqual(['-1', '-2'])
    expect(parseFlags(['--name=-x'], defs)['--name']).toBe('-x')
    expect(parseFlags(['-', '--dryrun'], defs)['--dryrun']).toBe(true)
  })

  describe('declared short flags (#491)', () => {
    const shortDefs: FlagDef[] = [
      { name: '--table', short: '-t', type: 'string', description: 'Table' },
      { name: '--database', short: '-d', type: 'string[]', description: 'Databases' },
      { name: '--force', short: '-f', type: 'boolean', description: 'Force' },
      { name: '--yes', short: '-y', type: 'boolean', description: 'Yes' },
      { name: '--name', type: 'string', description: 'Name' },
    ]

    it('parses every form the long flag accepts, under the long name', () => {
      expect(parseFlags(['-t', 'users'], shortDefs)).toEqual({ '--table': 'users' })
      expect(parseFlags(['-t=users'], shortDefs)).toEqual({ '--table': 'users' })
      expect(parseFlags(['-tusers'], shortDefs)).toEqual({ '--table': 'users' })
      expect(parseFlags(['-d', 'a,b', '-d=c'], shortDefs)).toEqual({ '--database': ['a', 'b', 'c'] })
      expect(parseFlags(['-f', '--name', 'x'], shortDefs)).toEqual({ '--force': true, '--name': 'x' })
    })

    it('rejects bundled short flags as one unknown flag', () => {
      expect(() => parseFlags(['-fy'], shortDefs)).toThrow('Unknown flag: -fy')
      expect(() => parseFlags(['-ft', 'users'], shortDefs)).toThrow('Unknown flag: -ft')
      expect(() => parseFlags(['-ft=users'], shortDefs)).toThrow('Unknown flag: -ft')
    })

    it('keeps a value that looks like a short flag', () => {
      expect(parseFlags(['--name', '-t'], shortDefs)).toEqual({ '--name': '-t' })
      expect(parseFlags(['-t', '-f'], shortDefs)).toEqual({ '--table': '-f' })
      expect(parseFlags(['--name=-t', '-f'], shortDefs)).toEqual({ '--name': '-t', '--force': true })
    })

    it('rejects unknown shorts, a boolean with a value and a missing value', () => {
      expect(() => parseFlags(['-x'], shortDefs)).toThrow('Unknown flag: -x')
      expect(() => parseFlags(['-fx'], shortDefs)).toThrow('Unknown flag: -fx')
      expect(() => parseFlags(['-f=1'], shortDefs)).toThrow(UnknownFlagError)
      expect(() => parseFlags(['-t'], shortDefs)).toThrow('Missing value for --table')
      expect(() => parseFlags(['-t', '--force'], shortDefs)).toThrow('Missing value for --table')
    })

    it('expandShortFlags rewrites known shorts and leaves everything else', () => {
      expect(expandShortFlags(['status', '-t', 'u', '-x', '-', '--name', '-f', '-f'], shortDefs)).toEqual([
        'status',
        '--table',
        'u',
        '-x',
        '-',
        '--name',
        '-f',
        '--force',
      ])
      expect(expandShortFlags(['-t=u', '-fy', '-ta=b', '--', '-f'], shortDefs)).toEqual(['--table=u', '-fy', '--table=a=b', '--', '-f'])
    })
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

  it('parses --name=value equals form for string flags', () => {
    const result = parseFlags(['--name=my-migration'], defs)
    expect(result['--name']).toBe('my-migration')
  })

  it('accepts empty value for --name= form', () => {
    const result = parseFlags(['--name='], defs)
    expect(result['--name']).toBe('')
  })

  it('parses --name=value for string[] flags', () => {
    const result = parseFlags(['--database=db1,db2'], defs)
    expect(result['--database']).toEqual(['db1', 'db2'])
  })

  it('rejects equals form on boolean flags', () => {
    expect(() => parseFlags(['--json=true'], defs)).toThrow(UnknownFlagError)
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
