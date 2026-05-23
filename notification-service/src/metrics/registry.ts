import { collectDefaultMetrics, Counter, Registry } from "prom-client";
import { METRIC_NAMES } from "../../../shared-contracts/src/metrics";

// module-level singleton, не создавать в обработчике запроса (ошибка duplicate-registration)
export const registry = new Registry();
registry.setDefaultLabels({ application: "notification-service" });
collectDefaultMetrics({ register: registry });

// OBS-03: события прочитаны из очереди. label event_type=stock.low.
// инкрементится в consumer.ts на КАЖДУЮ доставку (включая validation_error -
// событие физически пришло, но payload poisoned). low_stock_alerts_total ниже
// инкрементится только на успешном email path, разница = ошибки доставки.
export const stockEventsConsumedCounter = new Counter({
  name: METRIC_NAMES.STOCK_EVENTS_CONSUMED_TOTAL,
  help: "Total stock events consumed from RabbitMQ",
  labelNames: ["event_type"],
  registers: [registry],
});

// OBS-03: low-stock alerts отправлены. инкрементится после успешного
// sendLowStockEmail. email_error path НЕ инкрементит - это видно по разнице с
// stock_events_consumed_total.
export const lowStockAlertsCounter = new Counter({
  name: METRIC_NAMES.LOW_STOCK_ALERTS_TOTAL,
  help: "Total low-stock alerts dispatched (successful email sends)",
  registers: [registry],
});
