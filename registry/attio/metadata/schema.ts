import { rawTable } from '@chkit/plugin-ingest'

import { attioConfig } from '../config.js'

export const attioObjectsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_objects_raw` })
export const attioObjectAttributesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_object_attributes_raw` })
