export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'hotel-offers',
  /** Where the supplier endpoints live. Mocked inside this same service. */
  supplierBaseUrl: process.env.SUPPLIER_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  supplierTimeoutMs: Number(process.env.SUPPLIER_TIMEOUT_MS ?? 3000),
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 3600),
  /** Test hook (?simulateDown=...). Off unless explicitly enabled. */
  enableFailureInjection: process.env.ENABLE_FAILURE_INJECTION === 'true',
  workflowTimeoutMs: Number(process.env.WORKFLOW_TIMEOUT_MS ?? 20000),
};
