import { rawTable } from '@chkit/plugin-ingest'

import { attioConfig } from '../config.js'

export const attioNotesRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_notes_raw` })
