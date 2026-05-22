import { z } from "zod";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import {
  AdjustmentPayloadSchema,
  CommitReservationPayloadSchema,
  ReasonCode,
  ReleasePayloadSchema,
  ReservePayloadSchema,
  StockInPayloadSchema,
  StockOutPayloadSchema,
} from "./domain/eventSchemas";

// extendZodWithOpenApi уже вызван в domain/eventSchemas.ts при импорте.
// здесь повторно не вызываем - идемпотентно, но избегаем дубля.

export const registry = new OpenAPIRegistry();

// command DTO. поля идентичны валидационным схемам в commands.router.ts
// (там они объявлены приватно). держим единый источник правды через ref.
const StockInCommandSchema = z
  .object({
    aggregateId: z.string().min(1),
    productId: z.string().min(1),
    warehouseId: z.string().min(1),
    locationId: z.string().optional(),
    quantity: z.number().int().positive(),
    performedBy: z.string().optional(),
  })
  .openapi("StockInCommand");

const StockOutCommandSchema = z
  .object({
    aggregateId: z.string().min(1),
    productId: z.string().min(1),
    warehouseId: z.string().min(1),
    locationId: z.string().optional(),
    quantity: z.number().int().positive(),
    performedBy: z.string().optional(),
  })
  .openapi("StockOutCommand");

const AdjustmentCommandSchema = z
  .object({
    aggregateId: z.string().min(1),
    productId: z.string().min(1),
    warehouseId: z.string().min(1),
    quantity_delta: z.number().int(),
    reason_code: ReasonCode,
    notes: z.string().optional(),
    performedBy: z.string().optional(),
  })
  .openapi("AdjustmentCommand");

const ReserveCommandSchema = z
  .object({
    aggregateId: z.string().min(1),
    productId: z.string().min(1),
    warehouseId: z.string().min(1),
    locationId: z.string().optional(),
    quantity: z.number().int().positive(),
    reservationId: z.string().min(1),
    performedBy: z.string().optional(),
  })
  .openapi("ReserveCommand");

const ReleaseCommandSchema = z
  .object({
    aggregateId: z.string().min(1),
    productId: z.string().min(1),
    warehouseId: z.string().min(1),
    locationId: z.string().optional(),
    quantity: z.number().int().positive(),
    reservationId: z.string().min(1),
    performedBy: z.string().optional(),
  })
  .openapi("ReleaseCommand");

const CommitReservationCommandSchema = z
  .object({
    aggregateId: z.string().min(1),
    productId: z.string().min(1),
    warehouseId: z.string().min(1),
    locationId: z.string().optional(),
    quantity: z.number().int().positive(),
    reservationId: z.string().min(1),
    performedBy: z.string().optional(),
  })
  .openapi("CommitReservationCommand");

// response shape для command endpoints: 200 после append
const CommandResultSchema = z
  .object({
    aggregateId: z.string(),
    version: z.number().int(),
    event_type: z.string(),
    payload: z.unknown(),
  })
  .openapi("CommandResult");

// read model rows. форма повторяет ResultRow из read/readModels.ts
const StockBalanceSchema = z
  .object({
    product_id: z.string(),
    warehouse_id: z.string(),
    location_id: z.string(),
    on_hand: z.number().int(),
    reserved: z.number().int(),
    available: z.number().int(),
    updated_at: z.string(),
  })
  .openapi("StockBalance");

const StockMovementSchema = z
  .object({
    aggregate_id: z.string(),
    version: z.number().int(),
    event_type: z.string(),
    product_id: z.string(),
    warehouse_id: z.string(),
    quantity_delta: z.number().int(),
    occurred_at: z.string(),
  })
  .openapi("StockMovement");

const ErrorResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi("ErrorResponse");

const ValidationErrorSchema = z
  .object({
    errors: z.array(z.unknown()),
  })
  .openapi("ValidationError");

const ReplayResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string(),
  })
  .openapi("ReplayResult");

// регистрируем payload схемы (event_type-discriminated)
registry.register("StockInPayload", StockInPayloadSchema);
registry.register("StockOutPayload", StockOutPayloadSchema);
registry.register("AdjustmentPayload", AdjustmentPayloadSchema);
registry.register("ReservePayload", ReservePayloadSchema);
registry.register("ReleasePayload", ReleasePayloadSchema);
registry.register("CommitReservationPayload", CommitReservationPayloadSchema);

// id path param для detail dashboard
const aggregateIdParam = registry.registerParameter(
  "AggregateId",
  z.string().openapi({
    param: { name: "id", in: "path" },
    example: "00000000-0000-0000-0000-000000000000",
  }),
);

// ---------- write side (commands) ----------

registry.registerPath({
  method: "post",
  path: "/stock/commands/stock-in",
  summary: "Append STOCK_IN event to aggregate stream",
  request: {
    body: { content: { "application/json": { schema: StockInCommandSchema } } },
  },
  responses: {
    200: {
      description: "Event appended",
      content: { "application/json": { schema: CommandResultSchema } },
    },
    400: {
      description: "Validation failed",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    409: {
      description: "Optimistic concurrency conflict",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "Domain rule rejected",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/stock/commands/stock-out",
  summary: "Append STOCK_OUT event to aggregate stream",
  request: {
    body: { content: { "application/json": { schema: StockOutCommandSchema } } },
  },
  responses: {
    200: {
      description: "Event appended",
      content: { "application/json": { schema: CommandResultSchema } },
    },
    400: {
      description: "Validation failed",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    409: {
      description: "Optimistic concurrency conflict",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "Domain rule rejected (e.g. insufficient stock)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/stock/commands/adjustment",
  summary: "Append ADJUSTMENT event with signed quantity_delta and reason_code",
  request: {
    body: {
      content: { "application/json": { schema: AdjustmentCommandSchema } },
    },
  },
  responses: {
    200: {
      description: "Event appended",
      content: { "application/json": { schema: CommandResultSchema } },
    },
    400: {
      description: "Validation failed",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    409: {
      description: "Optimistic concurrency conflict",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "Domain rule rejected",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/stock/commands/reserve",
  summary: "Reserve quantity (available decreases, on_hand unchanged)",
  request: {
    body: { content: { "application/json": { schema: ReserveCommandSchema } } },
  },
  responses: {
    200: {
      description: "Event appended",
      content: { "application/json": { schema: CommandResultSchema } },
    },
    400: {
      description: "Validation failed",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    409: {
      description: "Optimistic concurrency conflict",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "Domain rule rejected (insufficient available stock)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/stock/commands/release",
  summary: "Release a prior reservation (reserved decreases)",
  request: {
    body: { content: { "application/json": { schema: ReleaseCommandSchema } } },
  },
  responses: {
    200: {
      description: "Event appended",
      content: { "application/json": { schema: CommandResultSchema } },
    },
    400: {
      description: "Validation failed",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    409: {
      description: "Optimistic concurrency conflict",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "Domain rule rejected",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/stock/commands/commit-reservation",
  summary: "Commit reservation - on_hand and reserved both decrease",
  request: {
    body: {
      content: {
        "application/json": { schema: CommitReservationCommandSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Event appended",
      content: { "application/json": { schema: CommandResultSchema } },
    },
    400: {
      description: "Validation failed",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    409: {
      description: "Optimistic concurrency conflict",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "Domain rule rejected",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------- read side (queries) ----------

registry.registerPath({
  method: "get",
  path: "/stock",
  summary: "List stock balances filtered by productId or warehouseId",
  request: {
    query: z.object({
      productId: z.string().optional(),
      warehouseId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Array of stock balance rows from read model",
      content: {
        "application/json": { schema: z.array(StockBalanceSchema) },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/stock/movements",
  summary: "List stock movements history (newest first)",
  request: {
    query: z.object({
      productId: z.string().optional(),
      warehouseId: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Array of stock movements",
      content: {
        "application/json": { schema: z.array(StockMovementSchema) },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/stock/{productId}/{warehouseId}",
  summary: "Get single stock balance row for product+warehouse pair",
  request: {
    params: z.object({
      productId: z.string(),
      warehouseId: z.string(),
    }),
    query: z.object({ locationId: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Stock balance row",
      content: { "application/json": { schema: StockBalanceSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------- admin (read-model rebuild) ----------

registry.registerPath({
  method: "post",
  path: "/admin/replay",
  summary: "Rebuild read model by replaying events (requires X-Admin-Key header)",
  responses: {
    200: {
      description: "Read model rebuilt from event log",
      content: { "application/json": { schema: ReplayResultSchema } },
    },
    403: {
      description: "Forbidden - missing or wrong X-Admin-Key",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Replay failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    503: {
      description: "ADMIN_KEY env var not configured",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ---------- dashboard (server-rendered HTML, mini event store UI) ----------

registry.registerPath({
  method: "get",
  path: "/dashboard",
  summary: "Mini event store dashboard - aggregate list and recent events",
  responses: {
    200: {
      description: "HTML page",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/dashboard/replay",
  summary: "Replay trigger page - shows before state and Trigger Replay button",
  responses: {
    200: {
      description: "HTML page",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/dashboard/replay",
  summary: "Trigger projection rebuild from event store (never returns 500)",
  responses: {
    200: {
      description: "HTML page with before/after state",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/dashboard/aggregate/{id}",
  summary: "Per-aggregate detail page - event stream, snapshots, folded state",
  request: { params: z.object({ id: aggregateIdParam }) },
  responses: {
    200: {
      description: "HTML page",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

// ---------- observability ----------

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Shallow liveness probe",
  responses: {
    200: {
      description: "Service is alive",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/actuator/prometheus",
  summary: "Prometheus metrics scrape endpoint (text/plain exposition format)",
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
    title: "Stock Service API",
    version: "1.0.0",
    description:
      "CQRS + Event Sourcing stock ledger. Write side appends events, read side serves projection. Mini event store dashboard at /dashboard.",
  },
  servers: [{ url: "/", description: "Local" }],
});
