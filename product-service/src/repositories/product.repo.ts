import { randomUUID } from "node:crypto";
import { pool } from "../config/db";
import { redis } from "../config/redis";
import { cacheRequestsCounter } from "../metrics/registry";
import type {
  CreateProductDto,
  Product,
  UpdateProductDto,
} from "../schemas/product.schema";

// все запросы через $N. конкатенация user-input в SQL запрещена (T-02-01)
const SELECT_ALL =
  "SELECT id, sku, name, description, unit, category, created_at, updated_at FROM products";

// TTL только safety-net. первичная инвалидация - явный DEL в update/remove (P12)
const CACHE_TTL = Number(process.env.REDIS_CACHE_TTL_SECONDS ?? 300);
const cacheKey = (id: string) => `product:${id}`;

export async function findById(id: string): Promise<Product | null> {
  // read-through cache-aside: get → hit или miss → DB → set
  const cached = await redis.get(cacheKey(id));
  if (cached) {
    cacheRequestsCounter.inc({ result: "hit" });
    console.log("[product-service] cache hit");
    return JSON.parse(cached) as Product;
  }

  cacheRequestsCounter.inc({ result: "miss" });
  console.log("[product-service] cache miss");

  const { rows } = await pool.query<Product>(
    `${SELECT_ALL} WHERE id = $1`,
    [id],
  );
  const product = rows[0] ?? null;
  if (product) {
    await redis.set(cacheKey(id), JSON.stringify(product), "EX", CACHE_TTL);
  }
  return product;
}

export async function findAll(): Promise<Product[]> {
  const { rows } = await pool.query<Product>(
    `${SELECT_ALL} ORDER BY created_at DESC`,
  );
  return rows;
}

export async function create(dto: CreateProductDto): Promise<Product> {
  const id = randomUUID();
  const { rows } = await pool.query<Product>(
    `INSERT INTO products (id, sku, name, description, unit, category, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING id, sku, name, description, unit, category, created_at, updated_at`,
    [id, dto.sku, dto.name, dto.description ?? null, dto.unit, dto.category],
  );
  return rows[0];
}

export async function update(
  id: string,
  dto: UpdateProductDto,
): Promise<Product | null> {
  // COALESCE даёт partial update без склейки SET-листа на лету
  const { rows, rowCount } = await pool.query<Product>(
    `UPDATE products
        SET sku         = COALESCE($2, sku),
            name        = COALESCE($3, name),
            description = COALESCE($4, description),
            unit        = COALESCE($5, unit),
            category    = COALESCE($6, category),
            updated_at  = NOW()
      WHERE id = $1
      RETURNING id, sku, name, description, unit, category, created_at, updated_at`,
    [
      id,
      dto.sku ?? null,
      dto.name ?? null,
      dto.description ?? null,
      dto.unit ?? null,
      dto.category ?? null,
    ],
  );
  if (!rowCount) return null;
  // P12: явный DEL, не SET. иначе stale-write через старое значение
  await redis.del(cacheKey(id));
  return rows[0];
}

export async function remove(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM products WHERE id = $1`, [
    id,
  ]);
  // DEL независимо от rowCount: ключ мог осесть в кеше после прошлого findById
  await redis.del(cacheKey(id));
  return (rowCount ?? 0) > 0;
}
