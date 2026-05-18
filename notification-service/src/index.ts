import express, { Request, Response } from "express";
import { registry } from "./metrics/registry";

const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 8082);

async function bootstrap() {
  // Phase 5+: await startConsumer();  // RabbitMQ consumer connect goes here.
  // Phase 1 has no DB and no broker — bootstrap() has no awaits.

  const app = express();

  // D-05: shallow liveness — 200 while the process is up, no dependency pings.
  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

  // OBS-01: exact path /actuator/prometheus (NOT /metrics). notification-service
  // has no business HTTP API — this Express server exists solely so Prometheus
  // sees 3/3 app targets, not 2/3 (PITFALLS P7).
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
