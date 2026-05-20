import { pool } from "../config/db";
import type { StockEvent } from "../domain/eventSchemas";

// synchronous projector. вызывается сразу после appendEvents в обработчиках команд.
// available column GENERATED ALWAYS - проектор пишет on_hand, postgres вычисляет available (T-04-04).
// все запросы через $N. payload-поля zod-валидированы до этого вызова (T-04-02).
export async function applyEventToReadModel(event: StockEvent): Promise<void> {
  const p = event.payload as Record<string, unknown> & {
    productId: string;
    warehouseId: string;
    locationId?: string;
    quantity?: number;
    quantity_delta?: number;
  };
  const locationId = p.locationId ?? "";

  let quantityChange = 0;

  switch (event.event_type) {
    case "STOCK_IN": {
      await pool.query(
        `INSERT INTO stock_balances (product_id, warehouse_id, location_id, on_hand, reserved)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (product_id, warehouse_id, location_id)
         DO UPDATE SET on_hand = stock_balances.on_hand + EXCLUDED.on_hand, updated_at = NOW()`,
        [p.productId, p.warehouseId, locationId, p.quantity],
      );
      quantityChange = p.quantity ?? 0;
      break;
    }
    case "STOCK_OUT": {
      // decide() уже проверил available >= quantity (ES-03), здесь on_hand не уйдёт ниже 0
      await pool.query(
        `INSERT INTO stock_balances (product_id, warehouse_id, location_id, on_hand, reserved)
         VALUES ($1, $2, $3, 0, 0)
         ON CONFLICT (product_id, warehouse_id, location_id)
         DO UPDATE SET on_hand = stock_balances.on_hand - $4, updated_at = NOW()`,
        [p.productId, p.warehouseId, locationId, p.quantity],
      );
      quantityChange = -(p.quantity ?? 0);
      break;
    }
    case "ADJUSTMENT": {
      // GREATEST(0,...) - safety floor если adjustment пришёл первым и no row exists
      await pool.query(
        `INSERT INTO stock_balances (product_id, warehouse_id, location_id, on_hand, reserved)
         VALUES ($1, $2, $3, GREATEST(0, $4), 0)
         ON CONFLICT (product_id, warehouse_id, location_id)
         DO UPDATE SET on_hand = GREATEST(0, stock_balances.on_hand + $4), updated_at = NOW()`,
        [p.productId, p.warehouseId, locationId, p.quantity_delta],
      );
      quantityChange = p.quantity_delta ?? 0;
      break;
    }
    default:
      console.log(
        `[stock-service] projector: unknown event_type=${event.event_type} - skipped (forward-compat)`,
      );
      return;
  }

  // читаем on_hand после upsert - нужно для stock_movement.on_hand_after
  const { rows } = await pool.query<{ on_hand: number }>(
    "SELECT on_hand FROM stock_balances WHERE product_id = $1 AND warehouse_id = $2 AND location_id = $3",
    [p.productId, p.warehouseId, locationId],
  );
  const onHandAfter = rows[0]?.on_hand ?? 0;

  await pool.query(
    `INSERT INTO stock_movement
       (product_id, warehouse_id, location_id, aggregate_id, event_type, quantity_change, on_hand_after, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      p.productId,
      p.warehouseId,
      locationId,
      event.aggregate_id,
      event.event_type,
      quantityChange,
      onHandAfter,
      event.occurred_at,
    ],
  );

  await pool.query(
    "UPDATE projection_offset SET last_event_at = $1, last_aggregate = $2, last_version = $3 WHERE id = 1",
    [event.occurred_at, event.aggregate_id, event.version],
  );

  console.log(
    `[stock-service] projected event_type=${event.event_type} product=${p.productId} wh=${p.warehouseId}`,
  );
}

// stub - полная реализация в Plan 04-03 (replay). нужен экспорт для admin router (04-03)
export async function rebuildReadModels(): Promise<void> {
  throw new Error("rebuildReadModels not yet implemented - see Plan 04-03");
}
