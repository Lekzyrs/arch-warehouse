import { collectDefaultMetrics, Registry } from "prom-client";

// module-level singleton, не создавать в обработчике запроса (ошибка duplicate-registration)
export const registry = new Registry();
registry.setDefaultLabels({ application: "product-service" });
collectDefaultMetrics({ register: registry });
