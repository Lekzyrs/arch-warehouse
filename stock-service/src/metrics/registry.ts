import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";
import { METRIC_NAMES } from "../../../shared-contracts/src/metrics";

// module-level singleton, не создавать в обработчике запроса (ошибка duplicate-registration)
export const registry = new Registry();
registry.setDefaultLabels({ application: "stock-service" });
collectDefaultMetrics({ register: registry });

// OBS-03: команды на запись. label command_type=STOCK_IN|STOCK_OUT|ADJUSTMENT|
// RESERVE|RELEASE|COMMIT_RESERVATION, result=success|conflict|rejected.
// label set расширен относительно плана (был только command) - сохраняем
// разделение success/conflict/rejected, оно уже использовалось в Phase 3
// commands.router.ts и нужно для grafana dashboard "rejected vs success".
export const stockCommandsCounter = new Counter({
  name: METRIC_NAMES.STOCK_COMMANDS_TOTAL,
  help: "Total stock commands processed by stock-service",
  labelNames: ["command_type", "result"],
  registers: [registry],
});

// OBS-03 + EDA-03: события опубликованы в RabbitMQ. label event_type=stock.low
// (других publish-event types пока нет, label оставляем для forward-compat).
export const stockEventsPublishedCounter = new Counter({
  name: METRIC_NAMES.STOCK_EVENTS_PUBLISHED_TOTAL,
  help: "Total stock events published to RabbitMQ",
  labelNames: ["event_type"],
  registers: [registry],
});

// OBS-03 + CQRS: задержка проектора. секунд между event.occurred_at последнего
// прокинутого события и моментом завершения проекции. Gauge (не Counter) -
// значение может уменьшаться по мере догона. projector.ts вызывает .set() после
// каждого applyEventToReadModel.
export const projectionLagGauge = new Gauge({
  name: METRIC_NAMES.PROJECTION_LAG_SECONDS,
  help: "Seconds between last event timestamp and projection completion",
  registers: [registry],
});
