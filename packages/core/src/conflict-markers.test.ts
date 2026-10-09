import { describe, expect, test } from 'bun:test'

import { hasConflictMarkers } from './conflict-markers.js'

describe('hasConflictMarkers', () => {
  test('detects the lines git writes for a conflict, including diff3, longer markers and CRLF', () => {
    const conflicts = [
      'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> feature\n',
      'a\n<<<<<<< ours\nb\n||||||| base\nx\n=======\nc\n>>>>>>> theirs\n',
      'a\r\n<<<<<<<<< HEAD\r\nb\r\n=========\r\nc\r\n>>>>>>>>> feature\r\n',
      '<<<<<<<\n',
      'b\n=======  \nc\n',
    ]
    for (const text of conflicts) expect(hasConflictMarkers(text)).toBe(true)
  })

  test('ignores marker-like text that git does not write as a conflict line', () => {
    const clean = [
      'export const a = 1\n',
      '  <<<<<<< HEAD\n',
      '<<<<<< six\n',
      '======= heading\n',
      "const sql = 'a <<<<<<< b'\n",
      '<<<<<<<HEAD\n',
    ]
    for (const text of clean) expect(hasConflictMarkers(text)).toBe(false)
  })
})
