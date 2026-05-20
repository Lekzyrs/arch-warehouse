import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// openapi-расширение один раз на уровне модуля. нужно для Phase 8 swagger
extendZodWithOpenApi(z);

// STOCK_IN payload. STOCK_OUT и ADJUSTMENT ветки добавляются в Plan 03-02
export const StockInPayloadSchema = z.object({
  event_type: z.literal("STOCK_IN"),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().optional(),
  quantity: z.number().int().positive(),
  performedBy: z.string().optional(),
});

// discriminated union по event_type. ветки расширяются в 03-02
export const EventPayloadSchema = z.discriminatedUnion("event_type", [
  StockInPayloadSchema,
]);

export type StockInPayload = z.infer<typeof StockInPayloadSchema>;
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
