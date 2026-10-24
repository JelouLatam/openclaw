import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayMethodRegistry } from "../../methods/registry.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

const runtime = vi.hoisted(() => ({
  handler: vi.fn<(options: GatewayRequestOptions) => Promise<void>>(),
}));
vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
  handleGatewayRequest: runtime.handler,
}));

const scopes: Record<string, string> = {
  "agent.identity.get": "operator.read",
  "sessions.list": "operator.sessions.read",
  "config.patch": "operator.admin",
};
const registry = { getScope: (method: string) => scopes[method] } as GatewayMethodRegistry;

function createFixture(closeAfter: number) {
  const harness = createDispatchTestHarness({
    getMethodRegistry: () => registry,
    buildRequestContext: () => ({
      getRuntimeConfig: () => ({
        gateway: { readRateLimit: { burst: 2, perSecond: 1, closeAfter } },
      }),
    }),
  });
  const client = createOperatorWsClient();
  let id = 0;
  const dispatch = async (method: string) => {
    id += 1;
    await harness.dispatcher.dispatch({ type: "req", id: `${id}`, method, params: {} }, client);
    return await harness.awaitResponseFrame(`${id}`);
  };
  return { harness, dispatch };
}

describe("per-connection read rate limit", () => {
  beforeEach(() => {
    runtime.handler.mockReset().mockImplementation(async (options) => {
      options.respond(true, {});
    });
  });

  it("rejects reads over budget before they reach a handler", async () => {
    const { dispatch, harness } = createFixture(0);
    expect((await dispatch("agent.identity.get")).ok).toBe(true);
    expect((await dispatch("agent.identity.get")).ok).toBe(true);
    const rejected = await dispatch("agent.identity.get");

    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "rate limit exceeded for agent.identity.get; retry after 1s",
        retryable: true,
        details: { method: "agent.identity.get", limit: "2 burst, 1/s" },
      },
    });
    expect(runtime.handler).toHaveBeenCalledTimes(2);
    expect(harness.logGateway.warn).toHaveBeenCalledOnce();
    expect((await dispatch("sessions.list")).ok).toBe(true);
  });

  it("leaves non-read methods to their own limits", async () => {
    const { dispatch } = createFixture(0);
    for (let index = 0; index < 5; index += 1) {
      expect((await dispatch("config.patch")).ok).toBe(true);
    }
  });

  it("closes a connection that keeps going after rejections", async () => {
    const { dispatch, harness } = createFixture(2);
    await dispatch("agent.identity.get");
    await dispatch("agent.identity.get");
    await dispatch("agent.identity.get");
    await dispatch("agent.identity.get");
    expect(harness.close).not.toHaveBeenCalled();

    await dispatch("agent.identity.get");
    await Promise.resolve();
    expect(harness.setCloseCause).toHaveBeenCalledWith("read-rate-limit", {
      method: "agent.identity.get",
      rejections: 3,
    });
    expect(harness.close).toHaveBeenCalledWith(1008, "read rate limit exceeded");
  });
});
