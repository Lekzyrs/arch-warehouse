import { Pool } from "pg";

// все поля из process.env с безопасным fallback, без config-объекта и dotenv
export const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? "postgres",
  password: process.env.POSTGRES_PASSWORD ?? "postgres",
  database: process.env.POSTGRES_DB ?? "product_db",
});

// seam для bootstrap схемы. сейчас таблиц нет
export async function initSchema(): Promise<void> {
  // пусто, pool.query ещё нет
  console.log(
    "[product-service] DB schema ready (no tables yet - Phase 2 adds products table)",
  );
}
