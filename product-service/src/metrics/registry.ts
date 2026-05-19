import { collectDefaultMetrics, Counter, Registry } from "prom-client";

// module-level singleton, не создавать в обработчике запроса (ошибка duplicate-registration)
export const registry = new Registry();
registry.setDefaultLabels({ application: "product-service" });
collectDefaultMetrics({ register: registry });

// cache hit/miss счётчик для PROD-05; регистрируется на тот же registry, не создаём новый
export const cacheRequestsTotal = new Counter({
  name: "cache_requests_total",
  help: "Cache hit/miss counter for product-service",
  labelNames: ["result"],
  registers: [registry],
});
