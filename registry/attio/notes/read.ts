import { IngestConfigError, type FetchContext } from '@chkit/plugin-ingest'

import { readCollection, toAttioRows, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export async function* readNotes(context: FetchContext, deps?: AttioClientDeps) {
  if (attioConfig.notesPageSize > 50) throw new IngestConfigError('Attio notesPageSize cannot exceed 50.')
  for await (const page of readCollection(context, {
    path: '/notes', idFields: ['workspace_id', 'note_id'], pageSize: attioConfig.notesPageSize,
  }, deps)) {
    yield { rows: toAttioRows(page, 'notes', ['workspace_id', 'note_id']) }
  }
}
