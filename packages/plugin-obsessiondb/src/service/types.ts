export interface Service {
  id: string
  name: string
  region?: string
}

export interface SelectedService {
  service_id: string
  service_name: string
}
