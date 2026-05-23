import { Pool } from "pg";
import { initReadModelSchema } from "../read/readModels";

// все поля из process.env с безопасным fallback, без config-объекта и dotenv
export const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? "postgres",
  password: process.env.POSTGRES_PASSWORD ?? "postgres",
  database: process.env.POSTGRES_DB ?? "stock_db",
});

// seam для bootstrap схемы. DDL идемпотентен через IF NOT EXISTS.
// UNIQUE (aggregate_id, version) - оптимистическая блокировка (ES-05, 03-03)
export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      aggregate_id TEXT NOT NULL,
      version      INTEGER NOT NULL,
      event_type   TEXT NOT NULL,
      payload      JSONB NOT NULL,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT events_aggregate_version_uq UNIQUE (aggregate_id, version)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshots (
      aggregate_id TEXT NOT NULL,
      version      INTEGER NOT NULL,
      state        JSONB NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (aggregate_id, version)
    )
  `);
  console.log("[stock-service] schema ready (events + snapshots)");

  // read-side DDL: stock_balances, stock_movement, projection_offset (CQRS-01)
  await initReadModelSchema();
}
