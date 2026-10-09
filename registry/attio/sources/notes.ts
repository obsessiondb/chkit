import { IngestConfigError, rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { defaultAttioClientDeps, readRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioNotesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_notes_raw` })

export function readNotes(context: FetchContext, deps: AttioClientDeps = defaultAttioClientDeps) {
  if (deps.config.notesPageSize > 50) throw new IngestConfigError('Attio notesPageSize cannot exceed 50.')
  return readRows(context, {
    resource: 'notes', request: {
      path: '/notes', idFields: ['workspace_id', 'note_id'], pageSize: deps.config.notesPageSize,
    },
  }, deps)
}
