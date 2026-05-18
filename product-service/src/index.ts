import express, { Request, Response } from "express";
import { initSchema } from "./config/db";
import { registry } from "./metrics/registry";
import { withRetry } from "./utils/retry";

const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 8080);

async function bootstrap() {
  // initSchema под connect retry/backoff. сейчас no-op, таблиц нет
  await withRetry(() => initSchema(), "product-service");

  const app = express();
  app.use(express.json());

  // shallow liveness: 200 пока процесс жив, без пинга зависимостей
  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

  // путь именно /actuator/prometheus, не /metrics
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
