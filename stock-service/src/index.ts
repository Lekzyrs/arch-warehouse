import express, { Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { initSchema } from "./config/db";
import {
  closePublisher,
  connect as connectPublisher,
  schedulePublisherReconnect,
} from "./messaging/publisher";
import { registry } from "./metrics/registry";
import { openapiSpec } from "./openapi";
import { adminRouter } from "./routes/admin.router";
import { commandsRouter } from "./routes/commands.router";
import { dashboardRouter } from "./routes/dashboard.router";
import { queryRouter } from "./routes/query.router";
import { withRetry } from "./utils/retry";

const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 8080);

async function bootstrap() {
  // initSchema под connect retry/backoff. создаёт events + snapshots таблицы
  await withRetry(() => initSchema(), "stock-service");

  // best-effort: publisher падает - сервис всё равно поднимается, projection
  // через try/catch не уронит запрос. low-stock alert просто молча не уйдёт.
  // если первый connect упал, listener'ы 'error'/'close' ещё не висят, поэтому
  // расписание реконнекта вешаем руками - иначе publisher остаётся мёртвым.
  try {
    await connectPublisher();
  } catch (e) {
    console.error(
      "[stock-service] RabbitMQ publisher connection failed (non-fatal):",
      e,
    );
    schedulePublisherReconnect();
  }

  // graceful shutdown - даём publisher закрыть канал и connection
  process.on("SIGTERM", async () => {
    await closePublisher();
    process.exit(0);
  });

  const app = express();
  app.use(express.json());

  // shallow liveness: 200 пока процесс жив, без пинга зависимостей
  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

  // путь именно /actuator/prometheus, не /metrics
  app.get("/actuator/prometheus", async (_req: Request, res: Response) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  // POST /stock/commands/stock-in -> append event в events table (ES-01)
  // remount под /stock/commands - чтобы GET /stock и POST /stock/commands/* не конфликтовали
  app.use("/stock/commands", commandsRouter);
  console.log("[stock-service] Stock command routes registered at /stock/commands");

  // GET /stock - читает stock_balances (CQRS-02 physical separation)
  app.use("/stock", queryRouter);
  console.log("[stock-service] Query routes registered at /stock");

  // POST /admin/replay - rebuild read model (CQRS-05/06, X-Admin-Key gated)
  app.use("/admin", adminRouter);
  console.log("[stock-service] Admin routes registered at /admin");

  // GET /dashboard - server-rendered event store index (aggregate list + recent events)
  app.use("/dashboard", dashboardRouter);
  console.log("[stock-service] Dashboard routes registered at /dashboard");

  // raw openapi json: регистрируется ДО swaggerUi.serve, иначе swagger-ui
  // middleware на /docs/* перехватит /docs/json и вернёт HTML
  app.get("/docs/json", (_req: Request, res: Response) =>
    res.json(openapiSpec),
  );
  // swagger UI на /docs. путь /docs не пересекается с /stock|/admin|/dashboard.
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));
  console.log(`[stock-service] Swagger UI: http://localhost:${PORT}/docs`);

  app.listen(PORT, () =>
    console.log(`[stock-service] Listening on http://0.0.0.0:${PORT}`),
  );
}

bootstrap().catch((err) => {
  console.error("[stock-service] Failed to start:", err);
  process.exit(1);
});
