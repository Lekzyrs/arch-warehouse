// url только из env с дефолтами
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
