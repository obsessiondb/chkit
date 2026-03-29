import type { z } from 'zod'
import type { serviceSchema } from '../contract/index.js'

export type Service = z.infer<typeof serviceSchema>

export interface SelectedService {
  service_id: string
  service_name: string
}
