import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  createTalkRealtimeRelaySession,
  flushTalkRealtimeRelayVoiceWrites,
  stopTalkRealtimeRelaySession,
} from "./index.js";

describe("talk realtime relay sender attribution", () => {
  it("attributes relayed user speech to the connection that created the relay", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    const tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-sender-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const cfg: OpenClawConfig = { agents: { entries: { main: { default: true } } } };
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    try {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "relay-sender-session", updatedAt: Date.now() },
      );
      const provider: RealtimeVoiceProviderPlugin = {
        id: "relay-test",
        label: "Relay Test",
        isConfigured: () => true,
        createBridge: (request) => {
          bridgeRequest = request;
          return {
            connect: vi.fn(async () => undefined),
            sendAudio: vi.fn(),
            setMediaTimestamp: vi.fn(),
            handleBargeIn: vi.fn(),
            submitToolResult: vi.fn(),
            acknowledgeMark: vi.fn(),
            close: vi.fn(),
            isConnected: vi.fn(() => true),
          };
        },
      };
      const session = createTalkRealtimeRelaySession({
        context: {
          broadcastToConnIds: vi.fn(),
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
          logGateway: { warn: vi.fn() },
        } as never,
        connId: "conn-speaker",
        cfg,
        sender: {
          id: "profile-speaker",
          name: "Grace Hopper",
          identity: { type: "profile", id: "profile-speaker" },
        },
        provider,
        providerConfig: {},
        controlSource: "transcript",
        instructions: "brief",
        tools: [],
        sessionTarget: prepareTalkSessionTarget(cfg, "agent:main:main"),
      });
      bridgeRequest?.onTranscript?.("user", "relay hello", true);
      bridgeRequest?.onTranscript?.("assistant", "relay response", true);
      await flushTalkRealtimeRelayVoiceWrites({
        relaySessionId: session.relaySessionId,
        connId: "conn-speaker",
      });

      const events = readSessionTranscriptMessageEvents({
        agentId: "main",
        sessionId: "relay-sender-session",
      });
      expect(events[0]?.event).toHaveProperty("message.__openclaw", {
        senderId: "profile-speaker",
        senderName: "Grace Hopper",
        senderIdentity: { type: "profile", id: "profile-speaker" },
      });
      expect(events[1]?.event).not.toHaveProperty("message.__openclaw");
      await stopTalkRealtimeRelaySession({
        relaySessionId: session.relaySessionId,
        connId: "conn-speaker",
      });
      expect(clientVoiceSessionTesting.readRecord("main", session.relaySessionId)?.status).toBe(
        "closed",
      );
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
