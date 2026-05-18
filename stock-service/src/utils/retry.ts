// retry с экспоненциальным backoff, своя копия в каждом сервисе (независимые npm-пакеты)
// 8 попыток, base 500ms, x2, cap 8s (~43.5s). на финальной ошибке throw -> process.exit(1) -> docker restart
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 8,
  baseDelayMs = 500,
  capMs = 8000,
): Promise<T> {
  let delay = baseDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.log(
        `[${label}] connect attempt ${attempt}/${maxAttempts} failed, retry in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, capMs);
    }
  }
  throw new Error("unreachable");
}
