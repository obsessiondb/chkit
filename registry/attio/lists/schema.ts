import { rawTable } from '@chkit/plugin-ingest'

import { attioConfig } from '../config.js'

export const attioListsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_lists_raw` })
export const attioListAttributesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_list_attributes_raw` })
export const attioEntriesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_entries_raw` })
