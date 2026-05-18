// Phase 1 placeholder broker topology — Phase 5 (EDA) finalizes these names.
// Names align with the planned EDA topology: EDA-01 "warehouse.exchange",
// EDA-02 "stock.low.notifications". URL is env-only (INFRA-04) with safe defaults.
export const RABBIT_CONFIG = {
  url:
    process.env.RABBITMQ_URL ??
    `amqp://${process.env.RABBITMQ_USER ?? "guest"}:${
      process.env.RABBITMQ_PASS ?? "guest"
    }@${process.env.RABBITMQ_HOST ?? "localhost"}:${
      process.env.RABBITMQ_PORT ?? "5672"
    }`,
  exchange: "warehouse.exchange",
  queue: "stock.low.notifications",
  routingKeyBinding: "stock.#",
  routingKeyPublish: "stock.low",
} as const;
