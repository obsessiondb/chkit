import { rawTable } from '@chkit/plugin-ingest'

import { attioConfig } from '../config.js'

export const attioTasksRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_tasks_raw` })
