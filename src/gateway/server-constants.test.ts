import { describe, expect, it } from "vitest";
import { resolveGatewayMaxPayloadBytes } from "./server-constants.js";

const MB = 1024 * 1024;

describe("resolveGatewayMaxPayloadBytes", () => {
  it("keeps the 25 MB default when the variable is unset or not a number", () => {
    expect(resolveGatewayMaxPayloadBytes({})).toBe(25 * MB);
    expect(resolveGatewayMaxPayloadBytes({ OPENCLAW_GATEWAY_MAX_PAYLOAD_MB: " " })).toBe(25 * MB);
    expect(resolveGatewayMaxPayloadBytes({ OPENCLAW_GATEWAY_MAX_PAYLOAD_MB: "big" })).toBe(25 * MB);
  });

  it("raises the ceiling to the configured size", () => {
    expect(resolveGatewayMaxPayloadBytes({ OPENCLAW_GATEWAY_MAX_PAYLOAD_MB: "72" })).toBe(72 * MB);
  });

  it("never lowers the default nor grows past 512 MB", () => {
    expect(resolveGatewayMaxPayloadBytes({ OPENCLAW_GATEWAY_MAX_PAYLOAD_MB: "10" })).toBe(25 * MB);
    expect(resolveGatewayMaxPayloadBytes({ OPENCLAW_GATEWAY_MAX_PAYLOAD_MB: "-5" })).toBe(25 * MB);
    expect(resolveGatewayMaxPayloadBytes({ OPENCLAW_GATEWAY_MAX_PAYLOAD_MB: "100000" })).toBe(
      512 * MB,
    );
  });
});
