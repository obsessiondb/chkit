import { describe, expect, test } from 'bun:test'

import {
  parseRenameColumnMappings,
  parseRenameDictionaryMappings,
  parseRenameTableMappings,
} from '../../../commands/generate/rename-mappings.js'

describe('rename mappings', () => {
  test('trim JavaScript whitespace', () => {
    // chkit-py's test_name_trim.py asserts the same (#580).
    expect(parseRenameTableMappings(['﻿db.old\x85 = db﻿.﻿new'])).toEqual([
      { oldDatabase: 'db', oldName: 'old\x85', newDatabase: 'db', newName: 'new', source: 'cli' },
    ])
    expect(parseRenameDictionaryMappings(['db.﻿old=db.new\x85'])).toEqual([
      { oldDatabase: 'db', oldName: 'old', newDatabase: 'db', newName: 'new\x85', source: 'cli' },
    ])
    expect(parseRenameColumnMappings(['﻿db.t.﻿old\x85=﻿new'])).toEqual([
      { database: 'db', table: 't', from: 'old\x85', to: 'new', source: 'cli' },
    ])
  })
})
