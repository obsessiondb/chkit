import { describe, expect, test } from 'bun:test'

import * as cliModule from './index'

describe('@chx/cli smoke', () => {
  test('imports package entry', () => {
    expect(typeof cliModule).toBe('object')
  })
})
