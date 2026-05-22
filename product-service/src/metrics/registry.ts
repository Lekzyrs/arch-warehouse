import { collectDefaultMetrics, Counter, Registry } from "prom-client";
import { METRIC_NAMES } from "../../../shared-contracts/src/metrics";

// module-level singleton, не создавать в обработчике запроса (ошибка duplicate-registration)
export const registry = new Registry();
registry.setDefaultLabels({ application: "product-service" });
collectDefaultMetrics({ register: registry });

// cache hit/miss счётчик для PROD-05 / OBS-03. registers:[registry] чтобы попасть
// в /actuator/prometheus, иначе осел бы в default global registry. name берётся
// из shared-contracts METRIC_NAMES - одна точка истины для всех 3 сервисов.
export const cacheRequestsCounter = new Counter({
  name: METRIC_NAMES.CACHE_REQUESTS_TOTAL,
  help: "Cache hit/miss counter for product-service",
  labelNames: ["result"],
  registers: [registry],
});
