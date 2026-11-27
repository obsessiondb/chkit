import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PYTHON_FLOAT_SOURCE, pythonFloat } from './python-float.js'

// [value, str(value)] from CPython 3.
const PYTHON: Array<[number, string]> = [
  [0, '0.0'], [-0, '-0.0'], [1, '1.0'], [1000, '1000.0'], [1.5, '1.5'], [2.25, '2.25'], [0.1, '0.1'],
  [1e10, '10000000000.0'], [1e15, '1000000000000000.0'], [1e16, '1e+16'], [1.5e16, '1.5e+16'],
  [1.2345678901234568e17, '1.2345678901234568e+17'], [1e-4, '0.0001'], [1e-5, '1e-05'], [1.5e-5, '1.5e-05'],
  [0.00012345, '0.00012345'], [-3, '-3.0'], [-2.5e-7, '-2.5e-07'], [1e21, '1e+21'], [1e22, '1e+22'],
  [5e-324, '5e-324'], [1.7976931348623157e308, '1.7976931348623157e+308'], [100, '100.0'], [0.3, '0.3'],
  [1 / 3, '0.3333333333333333'], [12345.678, '12345.678'],
]
const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('pythonFloat', () => {
  test("formats like Python's str(float)", () => {
    expect(PYTHON.map(([value]) => pythonFloat(value))).toEqual(PYTHON.map(([, text]) => text))
  })

  test('the helper emitted into generated queries behaves the same', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-tinybird-float-'))
    dirs.push(dir)
    const file = join(dir, 'helper.ts')
    await writeFile(file, `${PYTHON_FLOAT_SOURCE}\nexport { pythonFloat }\n`)
    const emitted: { pythonFloat: (value: number) => string } = await import(pathToFileURL(file).href)
    expect(PYTHON.map(([value]) => emitted.pythonFloat(value))).toEqual(PYTHON.map(([, text]) => text))
  })
})
