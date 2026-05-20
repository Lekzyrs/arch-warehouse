import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// openapi-расширение один раз на уровне модуля. нужно для Phase 8 swagger
extendZodWithOpenApi(z);

// STOCK_IN payload
export const StockInPayloadSchema = z.object({
  event_type: z.literal("STOCK_IN"),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().optional(),
  quantity: z.number().int().positive(),
  performedBy: z.string().optional(),
});

// STOCK_OUT payload. quantity всегда положительный; знак фиксирован event_type
export const StockOutPayloadSchema = z.object({
  event_type: z.literal("STOCK_OUT"),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().optional(),
  quantity: z.number().int().positive(),
  performedBy: z.string().optional(),
});

// ES-04: ровно три значения по условию курсовой
export const ReasonCode = z.enum(["CYCLE_COUNT", "DAMAGE", "LOSS"]);

// ADJUSTMENT payload. quantity_delta - signed; +N добавляет, -N уменьшает on_hand
export const AdjustmentPayloadSchema = z.object({
  event_type: z.literal("ADJUSTMENT"),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  quantity_delta: z.number().int(),
  reason_code: ReasonCode,
  notes: z.string().optional(),
  performedBy: z.string().optional(),
});

// trio-branch discriminated union. ES-07: payload типизирован контрактом
export const EventPayloadSchema = z.discriminatedUnion("event_type", [
  StockInPayloadSchema,
  StockOutPayloadSchema,
  AdjustmentPayloadSchema,
]);

export type StockInPayload = z.infer<typeof StockInPayloadSchema>;
export type StockOutPayload = z.infer<typeof StockOutPayloadSchema>;
export type AdjustmentPayload = z.infer<typeof AdjustmentPayloadSchema>;
export type EventPayload = z.infer<typeof EventPayloadSchema>;

// row из events table. payload типизирован дискриминированным юнионом
export interface StockEvent {
  aggregate_id: string;
  version: number;
  event_type: string;
  payload: EventPayload;
  occurred_at: Date;
}

// snapshot state. version - последний применённый event; 0 = нет событий
export interface StockAggregateState {
  on_hand: number;
  reserved: number;
  version: number;
}
