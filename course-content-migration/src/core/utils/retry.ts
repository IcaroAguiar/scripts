export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries: number; baseDelayMs: number; onRetry?: (attempt: number, error: unknown) => Promise<void> }
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === options.retries) break;
      await options.onRetry?.(attempt + 1, error);
      await new Promise((resolve) => setTimeout(resolve, options.baseDelayMs * 2 ** attempt));
    }
  }

  throw lastError;
}
