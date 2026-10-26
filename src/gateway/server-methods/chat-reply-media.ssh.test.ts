import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

const sandboxMocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  ensureWorkspace: vi.fn(),
}));

vi.mock("../../agents/sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sandbox.js")>()),
  resolveSandboxContext: sandboxMocks.resolveContext,
  ensureSandboxWorkspaceForSession: sandboxMocks.ensureWorkspace,
}));

import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

describe("WebChat SSH sandbox attachment delivery", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-webchat-ssh-media-",
    });
    sandboxMocks.resolveContext.mockReset();
    sandboxMocks.ensureWorkspace.mockReset();
  });

  afterEach(async () => {
    await drainGlobalSingletonLifecycleState();
    await testState.cleanup();
  });

  function setup(denyRead: boolean) {
    const selected = testState.statePath("worktrees", "selected");
    const sandboxRoot = testState.statePath("remote-sandbox", "workspace");
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read"],
        ...(denyRead ? { toolsBySender: { "*": { deny: ["read"] } } } : {}),
      },
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "ssh",
            scope: "session",
            workspaceAccess: "rw",
            ssh: { target: "sandbox-worker" },
          },
        },
        list: [{ id: "main", workspace: selected }],
      },
    };
    const readFile = vi.fn(async ({ filePath }: { filePath: string }) => {
      if (filePath !== path.join(sandboxRoot, "reports", "preview.png")) {
        throw new Error(`Unexpected sandbox file: ${filePath}`);
      }
      return PNG_BYTES;
    });
    sandboxMocks.ensureWorkspace.mockResolvedValue({
      workspaceDir: sandboxRoot,
      containerWorkdir: "/workspace",
      workspaceAccess: "rw",
    });
    sandboxMocks.resolveContext.mockResolvedValue({
      backendId: "ssh",
      workspaceDir: sandboxRoot,
      containerWorkdir: "/workspace",
      workspaceAccess: "rw",
      fsBridge: { readFile },
    });
    return { cfg, selected, readFile };
  }

  it.each(["reports/preview.png", "/workspace/reports/preview.png"])(
    "stages %s through the sandbox bridge instead of the Gateway filesystem",
    async (source) => {
      const { cfg, selected, readFile } = setup(false);
      const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:webchat:direct:user",
        sessionEntry: {
          sessionId: "ssh-media-session",
          updatedAt: 1,
          sessionRoot: selected,
          permissionMode: "workspace",
        },
        payloads: [{ mediaUrls: [source] }],
      });
      expect(readFile).toHaveBeenCalledTimes(1);
      const stagedPath = payload?.mediaUrls?.[0];
      if (!stagedPath) {
        throw new Error("Expected a managed attachment");
      }
      expect(await fs.readFile(stagedPath)).toEqual(PNG_BYTES);
    },
  );

  it("does not provision a sandbox for a text-only reply", async () => {
    const { cfg, selected } = setup(false);
    const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg,
      agentId: "main",
      sessionKey: "agent:main:webchat:direct:user",
      sessionEntry: {
        sessionId: "ssh-text-session",
        updatedAt: 1,
        sessionRoot: selected,
      },
      payloads: [{ text: "Hello" }],
    });
    expect(payloads).toEqual([{ text: "Hello" }]);
    expect(sandboxMocks.resolveContext).not.toHaveBeenCalled();
    expect(sandboxMocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("does not read remote output when sender policy denies files", async () => {
    const { cfg, selected, readFile } = setup(true);
    const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg,
      agentId: "main",
      sessionKey: "agent:main:webchat:direct:user",
      sessionEntry: {
        sessionId: "ssh-media-denied-session",
        updatedAt: 1,
        sessionRoot: selected,
        permissionMode: "workspace",
      },
      payloads: [{ mediaUrls: ["reports/preview.png"] }],
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(payload?.mediaUrls).toBeUndefined();
  });
});
