export interface HealthResponse {
  status: 'ok';
}

export interface ReadinessResponse {
  status: 'ready' | 'unavailable';
}
