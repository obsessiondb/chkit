import { definePipeline, defineStream } from '@chkit/plugin-ingest'

import { classifyAttioError, defaultAttioClientDeps, type AttioClientDeps } from './client.js'
import { attioConfig, type AttioReaderConfig } from './config.js'
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

// One records stream per object type; no reader traverses other objects.
// Keep schema exports when removing streams to retain existing stored data.
export function createAttioPipeline(config: AttioReaderConfig = attioConfig, deps: AttioClientDeps = defaultAttioClientDeps) {
  const client = { ...deps, config: { ...config, objects: [...config.objects], lists: [...config.lists] } }
  return definePipeline({
    id: config.sourceId,
    tags: ['provider:attio'],
    maxStreams: 1,
    maxFetches: 1,
    maxLoads: 1,
    retry: { retries: 5, minTimeout: 1_000, maxTimeout: 30_000, randomize: true },
    streams: [
      defineStream({ ...streamOptions, id: `${config.sourceId}.objects`, tags: ['resource:objects'], destination: attioObjectsRaw, read: (context) => readObjects(context, client) }),
      ...config.objects.flatMap((object) => [
        defineStream({ ...streamOptions, id: `${config.sourceId}.records.${object}`, tags: ['resource:records', `object:${object}`], destination: attioRecordsRaw, read: (context) => readRecords(context, object, client) }),
        defineStream({ ...streamOptions, id: `${config.sourceId}.object_attributes.${object}`, tags: ['resource:object_attributes', `object:${object}`], destination: attioObjectAttributesRaw, read: (context) => readObjectAttributes(context, object, client) }),
      ]),
      defineStream({ ...streamOptions, id: `${config.sourceId}.lists`, tags: ['resource:lists'], destination: attioListsRaw, read: (context) => readLists(context, client) }),
      ...config.lists.flatMap((list) => [
        defineStream({ ...streamOptions, id: `${config.sourceId}.entries.${list}`, tags: ['resource:entries', `list:${list}`], destination: attioEntriesRaw, read: (context) => readEntries(context, list, client) }),
        defineStream({ ...streamOptions, id: `${config.sourceId}.list_attributes.${list}`, tags: ['resource:list_attributes', `list:${list}`], destination: attioListAttributesRaw, read: (context) => readListAttributes(context, list, client) }),
      ]),
      defineStream({ ...streamOptions, id: `${config.sourceId}.notes`, tags: ['resource:notes'], destination: attioNotesRaw, read: (context) => readNotes(context, client) }),
      defineStream({ ...streamOptions, id: `${config.sourceId}.tasks`, tags: ['resource:tasks'], destination: attioTasksRaw, read: (context) => readTasks(context, client) }),
      defineStream({ ...streamOptions, id: `${config.sourceId}.members`, tags: ['resource:members'], destination: attioMembersRaw, read: (context) => readMembers(context, client) }),
    ],
  })
}

export const attio = createAttioPipeline()
