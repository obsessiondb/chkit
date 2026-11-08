import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fixture from '../../../test/fixtures/codec-server-matrix.json'
import { canonicalizeCodec, codec, codecFingerprint, parseCodec, renderCodec } from './codec.js'
import { columnTypeFingerprint } from './sql.js'
import { planDiff } from './planner.js'
import { table } from './model.js'
import type { ColumnCodecSpec } from './model-types.js'
import { validateDefinitions } from './validate.js'

// Identical, ordered exceptions in test_codec_server_matrix.py. Each pattern
// describes a server limitation or an unmodelled type, never a codec mismatch.
const EXCEPTIONS = [
  { category: 'non-codec', field: 'error', pattern: 'Incompatible data types between aggregate function', reason: 'SimpleAggregateFunction return type differs from its storage type.' },
  { category: 'non-codec', field: 'error', pattern: 'similar types', reason: 'Variant alternatives require a server setting.' },
  { category: 'non-codec', field: 'error', pattern: 'Syntax error:|Duplicate values in enum:|Elements of Enum data type', reason: 'Invalid Enum syntax or duplicate values are type errors.' },
  { category: 'non-codec', field: 'error', pattern: 'Map cannot have a key|Names are specified not for all elements', reason: 'Invalid Map key or partially named Tuple is a type error.' },
  { category: 'unmodelled', field: 'type', pattern: '\\b(Variant|AggregateFunction|Nested)\\s*\\(', reason: 'chkit does not model these value streams (Nested has no parent column).' },
  { category: 'integer-bound', field: 'codec', pattern: '^LZ4HC\\(-?9007199254740992\\)$|^ZSTD\\(-9223372036854775808\\)$', reason: 'Codec arguments beyond the shared JS safe-integer bound stay unparsed.' },
  { category: 'aliases', field: 'type', pattern: '\\b(Double|BIGINT|Point|Ring)\\b', reason: 'Type aliases are outside the codec type model.' },
] as const

function matrixTable(type: string, spec: ColumnCodecSpec) {
  return table({ database: 'db', name: 't', engine: 'MergeTree()', primaryKey: [], orderBy: [], columns: [{ name: 'c', type, codec: spec }] })
}

test('codec storage, pull, planner and validation match the server matrix in both ports', () => {
  const failures: string[] = []
  const rows: unknown[] = []
  const counts: { stored: number; rejected: number; exceptions: Record<string, number> } = { stored: 0, rejected: 0, exceptions: {} }
  const hits = EXCEPTIONS.map(() => 0)
  for (const entry of fixture.cases) {
    const exceptionIndex = EXCEPTIONS.findIndex(({ field, pattern }) => new RegExp(pattern).test(entry[field] ?? ''))
    const exception = EXCEPTIONS[exceptionIndex]
    const parsed = parseCodec(`CODEC(${entry.codec})`)
    const forms: ColumnCodecSpec[] = [codec.raw(entry.codec)]
    if (parsed?.every((atom) => atom.kind !== 'raw')) forms.push(parsed)
    const issues = forms.map((spec) => validateDefinitions([matrixTable(entry.type, spec)])
      .filter((issue) => issue.code.startsWith('codec_')).map(({ code, message }) => [code, message]))
    rows.push([entry.type, entry.codec, entry.server, exception?.category ?? '', issues])
    if (exception) {
      hits[exceptionIndex] = (hits[exceptionIndex] ?? 0) + 1
      counts.exceptions[exception.category] = (counts.exceptions[exception.category] ?? 0) + 1
    } else {
      const check = (ok: boolean, label: string) => {
        if (!ok) failures.push(`${entry.type} / ${entry.codec}: ${label}`)
      }
      if (entry.server === 'rejected') {
        counts.rejected += 1
        for (const result of issues) check(result.length > 0, 'validation accepted server rejection')
      } else {
        check(entry.server === 'stored', 'missing exception for absent parent column')
        if (entry.server === 'stored' && entry.stored !== undefined && entry.storedType !== undefined) {
          counts.stored += 1
          const live = parseCodec(entry.stored)
          expect(live).toBeDefined()
          if (live) {
            const pulled = canonicalizeCodec(live)
            const expected = codecFingerprint(live, entry.storedType)
            // Do not let both sides silently erase a significant stored size.
            for (const atom of live) {
              if (atom.kind === 'DoubleDelta' && atom.size !== undefined) {
                check(expected.includes(`DoubleDelta(${atom.size})`), 'stored DoubleDelta size is significant')
              }
              if (atom.kind === 'FPC' && atom.floatSize !== undefined) {
                check(expected.includes(`FPC(${atom.level ?? 12},${atom.floatSize})`), 'stored FPC size is significant')
              }
            }
            check(codecFingerprint(pulled, entry.storedType) === expected, 'pull canonicalization')
            check(codecFingerprint(parseCodec(renderCodec(pulled)), entry.storedType) === expected, 'pull render round trip')
            for (const [index, spec] of forms.entries()) {
              check(issues[index]?.length === 0, `validation form ${index}: ${JSON.stringify(issues[index])}`)
              check(codecFingerprint(canonicalizeCodec(spec), entry.type) === expected, `drift form ${index}`)
              const source = matrixTable(entry.type, spec)
              const target = matrixTable(entry.storedType, pulled)
              if (issues[index]?.length === 0 && columnTypeFingerprint({ type: entry.type }) === columnTypeFingerprint({ type: entry.storedType })) {
                check(planDiff([source], [target]).operations.length === 0, `planner form ${index}`)
                check(planDiff([target], [source]).operations.length === 0, `reverse planner form ${index}`)
              }
            }
          }
        }
      }
    }
  }
  // Hash every case's raw/typed verdict and exact issue code/message, including
  // exceptions. Both ports pin the same digest so parity cannot silently drift.
  const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  console.log('codec-server-matrix', JSON.stringify(counts), digest)
  expect(hits.every((hit) => hit > 0)).toBe(true)
  expect(failures).toEqual([])
  expect(digest).toBe('2cd0ba0f0ba53db485f3a1eddb5a78b63234198d97a662a99da3afc530c6d2aa')
})
