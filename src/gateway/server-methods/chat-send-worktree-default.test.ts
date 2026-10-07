import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  createSessionForSend: vi.fn(),
  handleChatSend: vi.fn(),
  loadGatewaySessionEntryReadOnly: vi.fn(),
}));

vi.mock("./sessions-messaging.js", () => ({
  createSessionForSend: mocks.createSessionForSend,
}));
vi.mock("./chat-send-handler.js", () => ({
  handleChatSend: mocks.handleChatSend,
}));
vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: mocks.loadGatewaySessionEntryReadOnly,
}));

const { handleDirectExternalChatSend } = await import("./chat-send-external-entry.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function config(enabled: boolean): OpenClawConfig {
  const root = tempDirs.make("openclaw-chat-send-worktree-default-");
  const repo = path.join(root, "client");
  const plain = path.join(root, "atlas");
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  execFileSync("git", ["init", "-q", repo]);
  return {
    worktreeNewSessions: enabled,
    agents: {
      entries: {
        client: { workspace: repo },
        atlas: { workspace: plain },
      },
    },
  } as OpenClawConfig;
}

const personClient = {
  connect: { scopes: ["operator.write"] },
  authenticatedUserProfile: { profileId: "person" },
};

function send(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  client?: unknown;
  existing?: boolean;
}) {
  mocks.loadGatewaySessionEntryReadOnly.mockReturnValue({
    canonicalKey: params.sessionKey,
    entry: params.existing ? { sessionId: "existing" } : undefined,
  });
  const respond = vi.fn();
  const options = {
    params: { sessionKey: params.sessionKey, message: "hola", idempotencyKey: "run-1" },
    respond,
    context: { getRuntimeConfig: () => params.cfg },
    client: params.client ?? personClient,
  };
  return { options, respond, run: handleDirectExternalChatSend(options as never) };
}

beforeEach(() => {
  mocks.createSessionForSend.mockReset().mockResolvedValue({ ok: true });
  mocks.handleChatSend.mockReset().mockResolvedValue(undefined);
  mocks.loadGatewaySessionEntryReadOnly.mockReset();
});

describe("chat.send with worktreeNewSessions", () => {
  it("creates a person's new session through sessions.create before sending", async () => {
    const sessionKey = "agent:client:dashboard:personal";
    const { options, run } = send({ cfg: config(true), sessionKey });
    await run;
    expect(mocks.createSessionForSend).toHaveBeenCalledWith(options, sessionKey);
    expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
    const [created] = mocks.createSessionForSend.mock.invocationCallOrder;
    const [sent] = mocks.handleChatSend.mock.invocationCallOrder;
    expect(created).toBeLessThan(sent ?? 0);
  });

  it("leaves the send alone when the default does not apply", async () => {
    const cfg = config(true);
    const cases = [
      { cfg: config(false), sessionKey: "agent:client:dashboard:personal" },
      { cfg, sessionKey: "agent:client:dashboard:personal", existing: true },
      { cfg, sessionKey: "agent:client:main" },
      { cfg, sessionKey: "agent:atlas:dashboard:personal" },
      {
        cfg,
        sessionKey: "agent:client:dashboard:helper",
        client: {
          ...personClient,
          internal: {
            sessionCreation: { via: "spawn", actor: { type: "agent", id: "client" } },
          },
        },
      },
    ];
    for (const params of cases) {
      await send(params).run;
    }
    expect(mocks.createSessionForSend).not.toHaveBeenCalled();
    expect(mocks.handleChatSend).toHaveBeenCalledTimes(cases.length);
  });

  it("answers the creation error instead of sending on the shared checkout", async () => {
    const error = { code: "UNAVAILABLE", message: "agent workspace is not a git checkout" };
    mocks.createSessionForSend.mockResolvedValue({ ok: false, error });
    const { respond, run } = send({
      cfg: config(true),
      sessionKey: "agent:client:dashboard:personal",
    });
    await run;
    expect(respond).toHaveBeenCalledWith(false, undefined, error);
    expect(mocks.handleChatSend).not.toHaveBeenCalled();
  });
});
