import { rawTable } from '@chkit/plugin-ingest'

import { attioConfig } from '../config.js'

export const attioMembersRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_members_raw` })
