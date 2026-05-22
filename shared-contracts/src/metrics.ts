// domain metric names. одна точка истины для всех трёх сервисов: registry.ts
// импортирует константу, инстанс Counter/Gauge получает name из неё. опечатка
// в одном месте ловится при импорте, а не при первом запросе на /metrics.
export const METRIC_NAMES = {
  // product-service: cache-aside hit/miss. label result=hit|miss
  CACHE_REQUESTS_TOTAL: "cache_requests_total",
  // stock-service: команды на запись. label command=stock_in|stock_out|adjustment|reserve|release|commit_reservation
  STOCK_COMMANDS_TOTAL: "stock_commands_total",
  // stock-service: события опубликованы в RabbitMQ. label event_type=stock.low
  STOCK_EVENTS_PUBLISHED_TOTAL: "stock_events_published_total",
  // notification-service: события прочитаны из очереди. label event_type=stock.low
  STOCK_EVENTS_CONSUMED_TOTAL: "stock_events_consumed_total",
  // notification-service: low-stock alerts отправлены (после успешного email или с email_error)
  LOW_STOCK_ALERTS_TOTAL: "low_stock_alerts_total",
  // stock-service: gauge - секунд между last event.occurred_at и текущим временем
  // после проекции. может уменьшаться (Gauge, не Counter)
  PROJECTION_LAG_SECONDS: "projection_lag_seconds",
} as const;
