import { getLogger } from '@logtape/logtape'

import { isDebugEnabled } from './logging.js'

export function debug(category: string, message: string, detail?: unknown): void {
  if (!isDebugEnabled()) return
  const logger = getLogger(['chkit', category])
  if (detail !== undefined) {
    logger.debug(message, { detail })
    return
  }
  logger.debug(message)
}

export { isDebugEnabled } from './logging.js'
