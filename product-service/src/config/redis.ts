import Redis from "ioredis";

// все поля из process.env. password через || чтобы пустая строка трактовалась как "без пароля"
export const redis = new Redis({
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
});

export async function connectRedis(): Promise<void> {
  console.log("[product-service] connecting to Redis...");
  await redis.connect();
  console.log("[product-service] Redis connected");
}
