import express, { Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { initSchema } from "./config/db";
import { connectRedis } from "./config/redis";
import { registry } from "./metrics/registry";
import { openapiSpec } from "./openapi";
import { productsRouter } from "./routes/products.router";
import { withRetry } from "./utils/retry";

const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 8080);

async function bootstrap() {
  // initSchema под connect retry/backoff. создаёт products table
  await withRetry(() => initSchema(), "product-service");
  // redis connect под тот же retry. lazyConnect: true в клиенте, поэтому соединение здесь
  await withRetry(() => connectRedis(), "product-service");

  const app = express();
  app.use(express.json());

  // shallow liveness: 200 пока процесс жив, без пинга зависимостей
  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

  // путь именно /actuator/prometheus, не /metrics
  app.get("/actuator/prometheus", async (_req: Request, res: Response) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  app.use("/products", productsRouter);
  // raw openapi json: регистрируется ДО swaggerUi.serve, иначе swagger-ui
  // middleware на /docs/* перехватит /docs/json и вернёт HTML
  app.get("/docs/json", (_req: Request, res: Response) =>
    res.json(openapiSpec),
  );
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));
  console.log(`[product-service] Swagger UI: http://localhost:${PORT}/docs`);

  app.listen(PORT, () =>
    console.log(`[product-service] Listening on http://0.0.0.0:${PORT}`),
  );
}

bootstrap().catch((err) => {
  console.error("[product-service] Failed to start:", err);
  process.exit(1);
});
