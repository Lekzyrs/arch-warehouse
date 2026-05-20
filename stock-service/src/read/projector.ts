import { pool } from "../config/db";
import type { StockEvent } from "../domain/eventSchemas";
import { publishStockLow } from "../messaging/publisher";
import { resetReadModels } from "./readModels";

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
    case "RESERVE": {
      // WH-02: reserve не меняет on_hand. available пересчитается postgres'ом (GENERATED).
      // upsert чтобы первое событие на product+warehouse не упало (хотя обычно RESERVE идёт после STOCK_IN)
      await pool.query(
        `INSERT INTO stock_balances (product_id, warehouse_id, location_id, on_hand, reserved)
         VALUES ($1, $2, $3, 0, $4)
         ON CONFLICT (product_id, warehouse_id, location_id)
         DO UPDATE SET reserved = stock_balances.reserved + $4, updated_at = NOW()`,
        [p.productId, p.warehouseId, locationId, p.quantity],
      );
      quantityChange = 0; // физически товар не двигается
      break;
    }
    case "RELEASE": {
      await pool.query(
        `INSERT INTO stock_balances (product_id, warehouse_id, location_id, on_hand, reserved)
         VALUES ($1, $2, $3, 0, 0)
         ON CONFLICT (product_id, warehouse_id, location_id)
         DO UPDATE SET reserved = GREATEST(0, stock_balances.reserved - $4), updated_at = NOW()`,
        [p.productId, p.warehouseId, locationId, p.quantity],
      );
      quantityChange = 0;
      break;
    }
    case "COMMIT_RESERVATION": {
      // товар уходит со склада: on_hand -= quantity И reserved -= quantity
      await pool.query(
        `INSERT INTO stock_balances (product_id, warehouse_id, location_id, on_hand, reserved)
         VALUES ($1, $2, $3, 0, 0)
         ON CONFLICT (product_id, warehouse_id, location_id)
         DO UPDATE SET on_hand = stock_balances.on_hand - $4,
                       reserved = GREATEST(0, stock_balances.reserved - $4),
                       updated_at = NOW()`,
        [p.productId, p.warehouseId, locationId, p.quantity],
      );
      quantityChange = -(p.quantity ?? 0);
      break;
    }
    default:
      console.log(
        `[stock-service] projector: unknown event_type=${event.event_type} - skipped (forward-compat)`,
      );
      return;
  }

  // читаем on_hand + available после upsert. on_hand нужен для stock_movement.on_hand_after,
  // available - для проверки low-stock threshold (EDA-03). available это GENERATED column
  // (on_hand - reserved), postgres сам пересчитывает.
  const { rows } = await pool.query<{ on_hand: number; available: number }>(
    "SELECT on_hand, available FROM stock_balances WHERE product_id = $1 AND warehouse_id = $2 AND location_id = $3",
    [p.productId, p.warehouseId, locationId],
  );
  const onHandAfter = rows[0]?.on_hand ?? 0;
  const availableAfter = rows[0]?.available ?? 0;

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

  // EDA-03: low-stock alert. публикуем только для событий, которые могут уронить
  // available (STOCK_OUT, ADJUSTMENT, RESERVE, COMMIT_RESERVATION). STOCK_IN/RELEASE
  // увеличивают available - им сигналить low-stock бессмысленно.
  const reducesAvailable =
    event.event_type === "STOCK_OUT" ||
    event.event_type === "ADJUSTMENT" ||
    event.event_type === "RESERVE" ||
    event.event_type === "COMMIT_RESERVATION";

  if (reducesAvailable) {
    const LOW_STOCK_THRESHOLD = parseInt(
      process.env.LOW_STOCK_THRESHOLD ?? "10",
      10,
    );
    if (availableAfter <= LOW_STOCK_THRESHOLD) {
      console.log(
        `[stock-service] low stock detected productId=${p.productId} available=${availableAfter} threshold=${LOW_STOCK_THRESHOLD}`,
      );
      // best-effort publish. broker outage НЕ должен валить projection write -
      // try/catch + console.error, никакого re-throw.
      try {
        await publishStockLow({
          productId: p.productId,
          warehouseId: p.warehouseId,
          locationId: p.locationId,
          available: availableAfter,
          threshold: LOW_STOCK_THRESHOLD,
          aggregateId: event.aggregate_id,
          occurredAt: new Date().toISOString(),
        });
      } catch (e) {
        console.error("[stock-service] stock.low publish failed (non-fatal):", e);
      }
    }
  }
}

// deterministic replay (CQRS-05, CQRS-06). admin-only endpoint (T-04-12).
// ORDER BY occurred_at ASC NULLS LAST, aggregate_id ASC, version ASC - три уровня сортировки
// гарантируют byte-identical rebuild при одинаковом events table (P3 mitigation, T-04-14).
export async function rebuildReadModels(): Promise<void> {
  await resetReadModels();
  console.log("[stock-service] starting replay from events table");

  const result = await pool.query(
    `SELECT aggregate_id, version, event_type, payload, occurred_at
     FROM events
     ORDER BY occurred_at ASC NULLS LAST, aggregate_id ASC, version ASC`,
  );

  for (const row of result.rows) {
    await applyEventToReadModel(row as StockEvent);
  }

  console.log(
    `[stock-service] replay complete: ${result.rows.length} events replayed`,
  );
}
