// Source: 01-RESEARCH.md Pattern §4 (no codebase analog — new pattern for archfinal).
// Each service keeps its own copy (D-04: independent npm packages, no workspaces).
// Parameters: 8 attempts, 500ms base, 2x backoff, 8s cap → ~43.5s total ceiling.
// On final failure the error propagates → bootstrap() → process.exit(1) →
// Docker `restart: unless-stopped` relaunches the container.
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
