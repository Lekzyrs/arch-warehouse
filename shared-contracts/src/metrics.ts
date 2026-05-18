// Phase 1 placeholder metric names — later phases wire these to actual
// prom-client Counters/Histograms (Phase 2 cache, Phase 3 ES, Phase 5 EDA).
export const METRIC_NAMES = {
  COMMANDS_TOTAL: "warehouse_commands_total",
  EVENTS_PUBLISHED: "warehouse_events_published_total",
  EVENTS_CONSUMED: "warehouse_events_consumed_total",
  CACHE_REQUESTS: "warehouse_cache_requests_total",
  HTTP_REQUEST_DURATION: "http_request_duration_seconds",
} as const;
