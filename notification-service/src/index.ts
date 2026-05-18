import express, { Request, Response } from "express";
import { registry } from "./metrics/registry";

const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 8082);

async function bootstrap() {
  // нет DB/broker, поэтому bootstrap без await

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
}

bootstrap().catch((err) => {
  console.error("[notification-service] Failed to start:", err);
  process.exit(1);
});
