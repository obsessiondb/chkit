import { definePipeline, defineStream } from '@chkit/plugin-ingest'

import { classifyAttioError } from './client.js'
import { attioConfig } from './config.js'
import { scanCheckpoint } from './checkpoints.js'
import { attioObjectsRaw, readObjects } from './sources/objects.js'
import { attioObjectAttributesRaw, readObjectAttributes } from './sources/object-attributes.js'
import { attioRecordsRaw, readRecords } from './sources/records.js'
import { attioListsRaw, readLists } from './sources/lists.js'
import { attioListAttributesRaw, readListAttributes } from './sources/list-attributes.js'
import { attioEntriesRaw, readEntries } from './sources/entries.js'
import { attioNotesRaw, readNotes } from './sources/notes.js'
import { attioTasksRaw, readTasks } from './sources/tasks.js'
import { attioMembersRaw, readMembers } from './sources/members.js'

const streamOptions = { classifyError: classifyAttioError, batchSize: 500 }

// Delete a stream entry to stop collecting it. Keep its schema export to retain existing data.
// Every reader discovers its own parents; this array does not establish execution dependencies.
export const attio = definePipeline({
  id: attioConfig.sourceId,
  tags: ['provider:attio'],
  maxStreams: 1,
  maxFetches: 1,
  maxLoads: 1,
  retry: { retries: 5, minTimeout: 1_000, maxTimeout: 30_000, randomize: true },
  streams: [
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.objects`, tags: ['resource:objects'], incremental: scanCheckpoint('objects'), destination: attioObjectsRaw, read: readObjects }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.object_attributes`, tags: ['resource:object_attributes'], incremental: scanCheckpoint('object_attributes'), destination: attioObjectAttributesRaw, read: readObjectAttributes }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.records`, tags: ['resource:records'], incremental: scanCheckpoint('records'), destination: attioRecordsRaw, read: readRecords }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.lists`, tags: ['resource:lists'], incremental: scanCheckpoint('lists'), destination: attioListsRaw, read: readLists }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.list_attributes`, tags: ['resource:list_attributes'], incremental: scanCheckpoint('list_attributes'), destination: attioListAttributesRaw, read: readListAttributes }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.entries`, tags: ['resource:entries'], incremental: scanCheckpoint('entries'), destination: attioEntriesRaw, read: readEntries }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.notes`, tags: ['resource:notes'], incremental: scanCheckpoint('notes'), destination: attioNotesRaw, read: readNotes }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.tasks`, tags: ['resource:tasks'], incremental: scanCheckpoint('tasks'), destination: attioTasksRaw, read: readTasks }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.members`, tags: ['resource:members'], incremental: scanCheckpoint('members'), destination: attioMembersRaw, read: readMembers }),
  ],
})
