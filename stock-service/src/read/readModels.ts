import { pool } from "../config/db";

// read-side row (CQRS-02). available = on_hand - reserved, считается postgres'ом
export interface StockBalanceRow {
  product_id: string;
  warehouse_id: string;
  location_id: string;
  on_hand: number;
  reserved: number;
  available: number;
  updated_at: Date;
}

// DDL идемпотентен через IF NOT EXISTS. available GENERATED ALWAYS - запрет на прямую запись (T-04-04)
export async function initReadModelSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_balances (
      product_id    TEXT        NOT NULL,
      warehouse_id  TEXT        NOT NULL,
      location_id   TEXT        NOT NULL DEFAULT '',
      on_hand       INTEGER     NOT NULL DEFAULT 0,
      reserved      INTEGER     NOT NULL DEFAULT 0,
      available     INTEGER     NOT NULL GENERATED ALWAYS AS (on_hand - reserved) STORED,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT stock_balances_pk PRIMARY KEY (product_id, warehouse_id, location_id)
    )
  `);
  console.log("[stock-service] stock_balances table ready");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_movement (
      id              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
      product_id      TEXT        NOT NULL,
      warehouse_id    TEXT        NOT NULL,
      location_id     TEXT        NOT NULL DEFAULT '',
      aggregate_id    TEXT        NOT NULL,
      event_type      TEXT        NOT NULL,
      quantity_change INTEGER     NOT NULL,
      on_hand_after   INTEGER     NOT NULL,
      occurred_at     TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS stock_movement_product_wh_idx
      ON stock_movement (product_id, warehouse_id, occurred_at DESC)
  `);
  console.log("[stock-service] stock_movement table ready");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS projection_offset (
      id             INTEGER     NOT NULL DEFAULT 1,
      last_event_at  TIMESTAMPTZ,
      last_aggregate TEXT,
      last_version   INTEGER,
      CONSTRAINT projection_offset_pk PRIMARY KEY (id)
    )
  `);
  await pool.query(
    "INSERT INTO projection_offset (id) VALUES (1) ON CONFLICT DO NOTHING",
  );
  console.log("[stock-service] projection_offset table ready");
}

// SELECT-only из stock_balances. CQRS-02: read-side не трогает events table
export async function getBalance(
  productId: string,
  warehouseId: string,
  locationId = "",
): Promise<StockBalanceRow | null> {
  const { rows } = await pool.query<StockBalanceRow>(
    `SELECT product_id, warehouse_id, location_id, on_hand, reserved, available, updated_at
     FROM stock_balances
     WHERE product_id = $1 AND warehouse_id = $2 AND location_id = $3`,
    [productId, warehouseId, locationId],
  );
  return rows[0] ?? null;
}

// $N::text IS NULL OR ... - sargable nullable filter без динамического SQL
export async function listBalances(filters: {
  productId?: string | null;
  warehouseId?: string | null;
}): Promise<StockBalanceRow[]> {
  const { rows } = await pool.query<StockBalanceRow>(
    `SELECT product_id, warehouse_id, location_id, on_hand, reserved, available, updated_at
     FROM stock_balances
     WHERE ($1::text IS NULL OR product_id = $1)
       AND ($2::text IS NULL OR warehouse_id = $2)
     ORDER BY product_id, warehouse_id, location_id`,
    [filters.productId ?? null, filters.warehouseId ?? null],
  );
  return rows;
}

// movement history row. CQRS-04: read из stock_movement, не из events
export interface StockMovementRow {
  id: string;
  product_id: string;
  warehouse_id: string;
  location_id: string;
  aggregate_id: string;
  event_type: string;
  quantity_change: number;
  on_hand_after: number;
  occurred_at: Date;
}

// limit clamped до 500 (T-04-17 DoS mitigation). default 100
export async function listMovements(filters: {
  productId?: string | null;
  warehouseId?: string | null;
  limit?: number;
}): Promise<StockMovementRow[]> {
  const limit = Math.min(filters.limit ?? 100, 500);
  const { rows } = await pool.query<StockMovementRow>(
    `SELECT id, product_id, warehouse_id, location_id, aggregate_id,
            event_type, quantity_change, on_hand_after, occurred_at
     FROM stock_movement
     WHERE ($1::text IS NULL OR product_id = $1)
       AND ($2::text IS NULL OR warehouse_id = $2)
     ORDER BY occurred_at DESC
     LIMIT $3`,
    [filters.productId ?? null, filters.warehouseId ?? null, limit],
  );
  return rows;
}

// destructive: wipe read tables перед replay (CQRS-06).
// TRUNCATE - DDL, не транзакционен; admin-only operation (T-04-12 guarded)
export async function resetReadModels(): Promise<void> {
  await pool.query("TRUNCATE TABLE stock_balances");
  await pool.query("TRUNCATE TABLE stock_movement");
  await pool.query(
    "UPDATE projection_offset SET last_event_at = NULL, last_aggregate = NULL, last_version = NULL WHERE id = 1",
  );
  console.log("[stock-service] read models reset - ready for replay");
}
