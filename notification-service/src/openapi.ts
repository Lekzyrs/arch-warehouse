import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";

// notification-service не имеет других openapi-зависимых модулей,
// поэтому вызываем extendZodWithOpenApi здесь, один раз
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .openapi("HealthResponse");

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Shallow liveness probe",
  responses: {
    200: {
      description: "Service is alive",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/actuator/prometheus",
  summary:
    "Prometheus metrics scrape endpoint (text/plain exposition format)",
  responses: {
    200: {
      description: "Prometheus metrics in text exposition format",
      content: { "text/plain": { schema: z.string() } },
    },
  },
});

const generator = new OpenApiGeneratorV3(registry.definitions);
export const openapiSpec = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Notification Service API",
    version: "1.0.0",
    description:
      "Event consumer for low-stock notifications. HTTP surface is observability-only (health + metrics); business logic is the RabbitMQ consumer.",
  },
  servers: [{ url: "/", description: "Local" }],
});
