import express, { Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { closeConsumer, startConsumerWithRetry } from "./consumer";
import { registry } from "./metrics/registry";
import { openapiSpec } from "./openapi";

const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 8082);

async function bootstrap() {
  const app = express();

  // shallow liveness: 200 пока процесс жив, без пинга зависимостей
  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

  // путь именно /actuator/prometheus, не /metrics. business HTTP API нет,
  // этот Express нужен только чтобы Prometheus видел все 3 targets
  app.get("/actuator/prometheus", async (_req: Request, res: Response) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  // raw openapi json: регистрируется ДО swaggerUi.serve, иначе swagger-ui
  // middleware на /docs/* перехватит /docs/json и вернёт HTML
  app.get("/docs/json", (_req: Request, res: Response) =>
    res.json(openapiSpec),
  );
  // swagger UI на /docs. HTTP surface минимальный, но рубрика DOC-01 требует
  // /docs на всех HTTP-сервисах
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));
  console.log(`[notification-service] Swagger UI: http://localhost:${PORT}/docs`);

  app.listen(PORT, () =>
    console.log(
      `[notification-service] Metrics on :${PORT}/actuator/prometheus`,
    ),
  );

  // consumer стартует ПОСЛЕ http listen - чтобы k8s/health prober видел /health
  // даже если RabbitMQ ещё не доступен. retry-обёртка сама делает exponential
  // backoff (max 5 попыток, 1s/2s/4s/8s/16s) и process.exit(1) на терминальной
  // отказе - restart:unless-stopped поднимет контейнер.
  startConsumerWithRetry().catch((e) => {
    console.error("[notification-service] consumer retry loop failed:", e);
    process.exit(1);
  });
}

// graceful shutdown - закрываем consumer channel/connection чтобы in-flight
// сообщение не зависло. SIGTERM приходит от docker compose stop / k8s.
process.on("SIGTERM", async () => {
  await closeConsumer();
  process.exit(0);
});

bootstrap().catch((err) => {
  console.error("[notification-service] Failed to start:", err);
  process.exit(1);
});
