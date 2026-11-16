import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import {
  createPluginSubagentRequesterContext,
  resolvePluginSubagentCompletionRequester,
  type PluginSubagentRequesterContext,
} from "./runtime/subagent-requester-context.js";

function getActiveRequester(): PluginSubagentRequesterContext | undefined {
  try {
    return resolvePluginSubagentCompletionRequester("current-requester");
  } catch {
    return undefined;
  }
}

describe("before_dispatch requester authority", () => {
  it("expires each plugin scope before the next handler settles", async () => {
    const requester = createPluginSubagentRequesterContext({
      sessionKey: "agent:main:telegram:direct:123",
      origin: { channel: "telegram", to: "telegram:123" },
    });
    if (!requester) {
      throw new Error("expected valid requester context");
    }

    const detachedGate = createDeferred();
    const secondStarted = createDeferred();
    const releaseSecond = createDeferred();
    let detachedRead: Promise<PluginSubagentRequesterContext | undefined> | undefined;
    const registry = createMockPluginRegistry([
      {
        hookName: "before_dispatch",
        pluginId: "first",
        priority: 100,
        handler: async () => {
          expect(getActiveRequester()).toBe(requester);
          detachedRead = (async () => {
            await detachedGate.promise;
            return getActiveRequester();
          })();
          return { handled: false };
        },
      },
      {
        hookName: "before_dispatch",
        pluginId: "second",
        priority: 0,
        handler: async () => {
          expect(getActiveRequester()).toBe(requester);
          secondStarted.resolve();
          await releaseSecond.promise;
          return { handled: false };
        },
      },
    ]);

    const run = createHookRunner(registry).runBeforeDispatch({ content: "hello" }, {}, requester);
    await secondStarted.promise;
    detachedGate.resolve();
    if (!detachedRead) {
      throw new Error("expected detached requester read");
    }
    await expect(detachedRead).resolves.toBeUndefined();

    releaseSecond.resolve();
    await expect(run).resolves.toBeUndefined();
    expect(getActiveRequester()).toBeUndefined();
  });
});

describe("before_dispatch fail-closed admission", () => {
  it("stops at an opted-in throwing gate and returns a generic fixed reply", async () => {
    const later = vi.fn();
    const registry = createMockPluginRegistry([
      {
        hookName: "before_dispatch",
        pluginId: "gate",
        priority: 10,
        failurePolicy: "fail-closed",
        handler: () => {
          throw new Error("private failure");
        },
      },
      { hookName: "before_dispatch", pluginId: "later", handler: later },
    ]);
    await expect(
      createHookRunner(registry).runBeforeDispatch({ content: "hello" }, {}),
    ).resolves.toEqual({ handled: true, text: "Unable to verify this message. Please try again." });
    expect(later).not.toHaveBeenCalled();
  });

  it.each([undefined, 25])(
    "fails closed on its default or configured deadline: %s",
    async (timeoutMs) => {
      vi.useFakeTimers();
      try {
        const registry = createMockPluginRegistry([
          {
            hookName: "before_dispatch",
            pluginId: "gate",
            failurePolicy: "fail-closed",
            timeoutMs,
            handler: () => new Promise(() => {}),
          },
        ]);
        const run = createHookRunner(registry).runBeforeDispatch({ content: "hello" }, {});
        await vi.advanceTimersByTimeAsync(timeoutMs ?? 3_000);
        await expect(run).resolves.toMatchObject({ handled: true });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves existing fail-open behavior and normal handled text", async () => {
    const registry = createMockPluginRegistry([
      {
        hookName: "before_dispatch",
        pluginId: "legacy",
        priority: 10,
        handler: () => {
          throw new Error("legacy");
        },
      },
      {
        hookName: "before_dispatch",
        pluginId: "gate",
        failurePolicy: "fail-closed",
        handler: () => ({ handled: true, text: "Custom refusal" }),
      },
    ]);
    await expect(
      createHookRunner(registry).runBeforeDispatch({ content: "hello" }, {}),
    ).resolves.toEqual({ handled: true, text: "Custom refusal" });
  });
});

it("uses the plugin's fixed localized failure text", async () => {
  const registry = createMockPluginRegistry([
    {
      hookName: "before_dispatch",
      pluginId: "gate",
      failurePolicy: "fail-closed",
      failureText: "No pude verificar el mensaje. Intenta de nuevo.",
      handler: () => {
        throw new Error("failed");
      },
    },
  ]);
  await expect(
    createHookRunner(registry).runBeforeDispatch({ content: "hello" }, {}),
  ).resolves.toEqual({ handled: true, text: "No pude verificar el mensaje. Intenta de nuevo." });
});
