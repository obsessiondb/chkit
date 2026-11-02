import { definePipeline, defineStream } from '@chkit/plugin-ingest'

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

const streamOptions = { batchSize: 500 }

// One records stream per object type; no reader traverses other objects.
// Keep schema exports when removing streams to retain existing stored data.
export function createAttioPipeline(config: AttioReaderConfig = attioConfig) {
  const boundConfig = { ...config, objects: [...config.objects], lists: [...config.lists] }
  return definePipeline({
    id: boundConfig.sourceId,
    tags: ['provider:attio'],
    maxStreams: 1,
    maxFetches: 1,
    maxLoads: 1,
    retry: { retries: 5, minTimeout: 1_000, maxTimeout: 30_000, randomize: true },
    streams: [
      defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.objects`, tags: ['resource:objects'], destination: attioObjectsRaw, read: (context) => readObjects(context, boundConfig) }),
      ...boundConfig.objects.flatMap((object) => [
        defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.records.${object}`, tags: ['resource:records', `object:${object}`], destination: attioRecordsRaw, read: (context) => readRecords(context, object, boundConfig) }),
        defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.object_attributes.${object}`, tags: ['resource:object_attributes', `object:${object}`], destination: attioObjectAttributesRaw, read: (context) => readObjectAttributes(context, object, boundConfig) }),
      ]),
      defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.lists`, tags: ['resource:lists'], destination: attioListsRaw, read: (context) => readLists(context, boundConfig) }),
      ...boundConfig.lists.flatMap((list) => [
        defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.entries.${list}`, tags: ['resource:entries', `list:${list}`], destination: attioEntriesRaw, read: (context) => readEntries(context, list, boundConfig) }),
        defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.list_attributes.${list}`, tags: ['resource:list_attributes', `list:${list}`], destination: attioListAttributesRaw, read: (context) => readListAttributes(context, list, boundConfig) }),
      ]),
      defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.notes`, tags: ['resource:notes'], destination: attioNotesRaw, read: (context) => readNotes(context, boundConfig) }),
      defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.tasks`, tags: ['resource:tasks'], destination: attioTasksRaw, read: (context) => readTasks(context, boundConfig) }),
      defineStream({ ...streamOptions, id: `${boundConfig.sourceId}.members`, tags: ['resource:members'], destination: attioMembersRaw, read: (context) => readMembers(context, boundConfig) }),
    ],
  })
}

export const attio = createAttioPipeline()
