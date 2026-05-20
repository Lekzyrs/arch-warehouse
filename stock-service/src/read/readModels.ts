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
