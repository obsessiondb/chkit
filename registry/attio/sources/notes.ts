import { rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createAttioClient } from '../client.js'
import { attioConfig, type AttioReaderConfig } from '../config.js'
import { readRows } from './common.js'

export const attioNotesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_notes_raw` })

export async function* readNotes(context: SourceContext, config: AttioReaderConfig) {
  const client = createAttioClient(context, config)
  yield* readRows(client, {
    resource: 'notes', request: {
      path: '/notes', idFields: ['workspace_id', 'note_id'], pageSize: client.settings.notesPageSize,
    },
  })
}
