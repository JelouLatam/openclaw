import { describe, expect, it } from "vitest";
import {
  ConnectionReadRateLimiter,
  DEFAULT_READ_RATE_BURST,
  DEFAULT_READ_RATE_CLOSE_AFTER,
  DEFAULT_READ_RATE_PER_SECOND,
  READ_RATE_CLOSE_WINDOW_MS,
  resolveReadRateLimitOptions,
} from "./read-rate-limit.js";

describe("ConnectionReadRateLimiter", () => {
  it("admits a roster-sized burst and refills at the sustained rate", () => {
    const limiter = new ConnectionReadRateLimiter();
    const options = { burst: 150, perSecond: 10, closeAfter: 0 };
    for (let index = 0; index < 150; index += 1) {
      expect(limiter.consume("agent.identity.get", options, 0)).toEqual({ allowed: true });
    }
    expect(limiter.consume("agent.identity.get", options, 0)).toMatchObject({
      allowed: false,
      retryAfterMs: 100,
      shouldClose: false,
    });
    expect(limiter.consume("agent.identity.get", options, 100)).toEqual({ allowed: true });
    expect(limiter.consume("agent.identity.get", options, 100)).toMatchObject({ allowed: false });
  });

  it("keeps one budget per method", () => {
    const limiter = new ConnectionReadRateLimiter();
    const options = { burst: 1, perSecond: 1, closeAfter: 0 };
    expect(limiter.consume("agent.identity.get", options, 0).allowed).toBe(true);
    expect(limiter.consume("agent.identity.get", options, 0).allowed).toBe(false);
    expect(limiter.consume("sessions.list", options, 0).allowed).toBe(true);
  });

  it("asks to close only after sustained rejections within one window", () => {
    const options = { burst: 1, perSecond: 1, closeAfter: 2 };
    const limiter = new ConnectionReadRateLimiter();
    limiter.consume("agent.identity.get", options, 0);
    expect(limiter.consume("agent.identity.get", options, 1)).toMatchObject({ shouldClose: false });
    expect(limiter.consume("agent.identity.get", options, 2)).toMatchObject({ shouldClose: false });
    expect(limiter.consume("agent.identity.get", options, 3)).toMatchObject({
      shouldClose: true,
      rejections: 3,
    });

    const later = new ConnectionReadRateLimiter();
    later.consume("agent.identity.get", options, 0);
    later.consume("agent.identity.get", options, 1);
    later.consume("agent.identity.get", options, 2);
    const nextWindow = READ_RATE_CLOSE_WINDOW_MS + 1;
    later.consume("agent.identity.get", options, nextWindow);
    expect(later.consume("agent.identity.get", options, nextWindow)).toMatchObject({
      shouldClose: false,
      rejections: 1,
    });
  });

  it("is disabled by a zero burst", () => {
    const limiter = new ConnectionReadRateLimiter();
    const options = { burst: 0, perSecond: 1, closeAfter: 1 };
    for (let index = 0; index < 10; index += 1) {
      expect(limiter.consume("agent.identity.get", options, 0).allowed).toBe(true);
    }
  });
});

describe("resolveReadRateLimitOptions", () => {
  const defaults = {
    burst: DEFAULT_READ_RATE_BURST,
    perSecond: DEFAULT_READ_RATE_PER_SECOND,
    closeAfter: DEFAULT_READ_RATE_CLOSE_AFTER,
  };

  it("uses defaults far above interactive use", () => {
    expect(resolveReadRateLimitOptions(undefined)).toEqual(defaults);
    expect(defaults).toEqual({ burst: 600, perSecond: 10, closeAfter: 3_000 });
  });

  it("reads overrides, accepts zero to disable, and ignores invalid values", () => {
    expect(resolveReadRateLimitOptions({ burst: 0, perSecond: 2.5, closeAfter: 0 })).toEqual({
      burst: 0,
      perSecond: 2.5,
      closeAfter: 0,
    });
    expect(resolveReadRateLimitOptions({ burst: -5, perSecond: 0, closeAfter: 1.5 })).toEqual(
      defaults,
    );
  });
});
