// Per-connection read budget bounds a runaway client loop on operator.read RPCs.
export const DEFAULT_READ_RATE_BURST = 600;
export const DEFAULT_READ_RATE_PER_SECOND = 10;
export const DEFAULT_READ_RATE_CLOSE_AFTER = 3_000;
export const READ_RATE_CLOSE_WINDOW_MS = 60_000;

export type ReadRateLimitOptions = {
  /** Bucket capacity per method; 0 disables the limiter. */
  burst: number;
  perSecond: number;
  /** Rejections within one close window that close the socket; 0 never closes. */
  closeAfter: number;
};

export type ReadRateDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; shouldClose: boolean; rejections: number };

type ReadRateLimitConfig = {
  burst?: number;
  perSecond?: number;
  closeAfter?: number;
};

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Resolves `gateway.readRateLimit`; invalid or missing values keep the defaults. */
export function resolveReadRateLimitOptions(
  config: ReadRateLimitConfig | undefined,
): ReadRateLimitOptions {
  const perSecond = config?.perSecond;
  return {
    burst: nonNegativeInteger(config?.burst, DEFAULT_READ_RATE_BURST),
    perSecond:
      typeof perSecond === "number" && Number.isFinite(perSecond) && perSecond > 0
        ? perSecond
        : DEFAULT_READ_RATE_PER_SECOND,
    closeAfter: nonNegativeInteger(config?.closeAfter, DEFAULT_READ_RATE_CLOSE_AFTER),
  };
}

export function formatReadRateLimit(options: ReadRateLimitOptions): string {
  return `${options.burst} burst, ${options.perSecond}/s`;
}

type Bucket = { tokens: number; updatedAtMs: number };

/** Token bucket per method, owned by one WebSocket connection and dropped with it. */
export class ConnectionReadRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private rejectionWindowStartMs = 0;
  private rejections = 0;

  consume(method: string, options: ReadRateLimitOptions, nowMs = Date.now()): ReadRateDecision {
    const { burst, perSecond, closeAfter } = options;
    if (burst <= 0) {
      return { allowed: true };
    }
    let bucket = this.buckets.get(method);
    if (!bucket) {
      bucket = { tokens: burst, updatedAtMs: nowMs };
      this.buckets.set(method, bucket);
    } else {
      const elapsedMs = Math.max(0, nowMs - bucket.updatedAtMs);
      bucket.tokens = Math.min(burst, bucket.tokens + (elapsedMs * perSecond) / 1000);
      bucket.updatedAtMs = nowMs;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    if (nowMs - this.rejectionWindowStartMs >= READ_RATE_CLOSE_WINDOW_MS) {
      this.rejectionWindowStartMs = nowMs;
      this.rejections = 0;
    }
    this.rejections += 1;
    return {
      allowed: false,
      retryAfterMs: Math.ceil(((1 - bucket.tokens) * 1000) / perSecond),
      shouldClose: closeAfter > 0 && this.rejections > closeAfter,
      rejections: this.rejections,
    };
  }
}
