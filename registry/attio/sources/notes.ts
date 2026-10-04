import { IngestConfigError, rawTable } from '@chkit/plugin-ingest'

import { readCollectionScan, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'
import type { AttioReadContext } from '../checkpoints.js'

export const attioNotesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_notes_raw` })

export async function* readNotes(context: AttioReadContext, deps?: AttioClientDeps) {
  if (attioConfig.notesPageSize > 50) throw new IngestConfigError('Attio notesPageSize cannot exceed 50.')
  yield* readCollectionScan(context, 'notes', {
    path: '/notes', idFields: ['workspace_id', 'note_id'], pageSize: attioConfig.notesPageSize,
  }, deps)
}
