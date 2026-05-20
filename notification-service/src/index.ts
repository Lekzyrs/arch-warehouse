import express, { Request, Response } from "express";
import { startConsumerWithRetry } from "./consumer";
import { registry } from "./metrics/registry";

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

process.on("SIGTERM", () => process.exit(0));

bootstrap().catch((err) => {
  console.error("[notification-service] Failed to start:", err);
  process.exit(1);
});
