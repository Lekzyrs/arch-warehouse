import { Pool } from "pg";

// INFRA-04: every field comes from process.env with a safe fallback.
// No config object, no dotenv package.
export const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? "postgres",
  password: process.env.POSTGRES_PASSWORD ?? "postgres",
  database: process.env.POSTGRES_DB ?? "product_db",
});

// D-02/D-03: the schema-bootstrap hook exists from Phase 1 so later phases
// extend it (not invent it). Phase 1 skeleton has no tables — Phase 2 adds
// CREATE TABLE IF NOT EXISTS products (...) here.
export async function initSchema(): Promise<void> {
  // intentionally empty for Phase 1 skeleton (no pool.query yet)
  console.log(
    "[product-service] DB schema ready (no tables yet — Phase 2 adds products table)",
  );
}
