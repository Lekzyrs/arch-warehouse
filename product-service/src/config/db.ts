import { Pool } from "pg";

// все поля из process.env с безопасным fallback, без config-объекта и dotenv
export const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? "postgres",
  password: process.env.POSTGRES_PASSWORD ?? "postgres",
  database: process.env.POSTGRES_DB ?? "product_db",
});

// seam для bootstrap схемы. CREATE TABLE IF NOT EXISTS - идемпотентно
export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      sku         TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      description TEXT,
      unit        TEXT NOT NULL,
      category    TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log("[product-service] products table ready");
}
