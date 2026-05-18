import express, { Request, Response } from "express";
import { initSchema } from "./config/db";
import { registry } from "./metrics/registry";
import { withRetry } from "./utils/retry";

const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 8080);

async function bootstrap() {
  // D-02/D-03: schema bootstrap behind connect retry/backoff. Phase 1
  // initSchema() is a no-op; the seam exists for Phase 2 to extend.
  await withRetry(() => initSchema(), "product-service");

  // Phase 2+: await connectRedis();
  // Phase 5+: await connectRabbitMQ();

  const app = express();
  app.use(express.json());

  // Phase 3+: app.use('/products', productsRouter);

  // D-05: shallow liveness — 200 while the process is up, no dependency pings.
  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

  // OBS-01: exact path /actuator/prometheus (NOT /metrics).
  app.get("/actuator/prometheus", async (_req: Request, res: Response) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  app.listen(PORT, () =>
    console.log(`[product-service] Listening on http://0.0.0.0:${PORT}`),
  );
}

bootstrap().catch((err) => {
  console.error("[product-service] Failed to start:", err);
  process.exit(1);
});
