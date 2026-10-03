import { definePipeline, defineStream } from '@chkit/plugin-ingest'

import { classifyAttioError } from './client.js'
import { attioConfig } from './config.js'
import { readEntries, readListAttributes, readLists } from './lists/read.js'
import { attioEntriesRaw, attioListAttributesRaw, attioListsRaw } from './lists/schema.js'
import { readMembers } from './members/read.js'
import { attioMembersRaw } from './members/schema.js'
import { readObjectAttributes, readObjects } from './metadata/read.js'
import { attioObjectAttributesRaw, attioObjectsRaw } from './metadata/schema.js'
import { readNotes } from './notes/read.js'
import { attioNotesRaw } from './notes/schema.js'
import { readRecords } from './records/read.js'
import { attioRecordsRaw } from './records/schema.js'
import { readTasks } from './tasks/read.js'
import { attioTasksRaw } from './tasks/schema.js'

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
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.objects`, tags: ['resource:objects'], destination: attioObjectsRaw, read: readObjects }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.object_attributes`, tags: ['resource:object_attributes'], destination: attioObjectAttributesRaw, read: readObjectAttributes }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.records`, tags: ['resource:records'], destination: attioRecordsRaw, read: readRecords }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.lists`, tags: ['resource:lists'], destination: attioListsRaw, read: readLists }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.list_attributes`, tags: ['resource:list_attributes'], destination: attioListAttributesRaw, read: readListAttributes }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.entries`, tags: ['resource:entries'], destination: attioEntriesRaw, read: readEntries }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.notes`, tags: ['resource:notes'], destination: attioNotesRaw, read: readNotes }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.tasks`, tags: ['resource:tasks'], destination: attioTasksRaw, read: readTasks }),
    defineStream({ ...streamOptions, id: `${attioConfig.sourceId}.members`, tags: ['resource:members'], destination: attioMembersRaw, read: readMembers }),
  ],
})
