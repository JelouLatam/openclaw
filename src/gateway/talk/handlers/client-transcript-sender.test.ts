import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { createOrResumeClientVoiceSession } from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { talkClientHandlers } from "./client.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const sessionKey = "agent:main:main";
const sessionId = "voice-sender-session";
let tempDir: string;

describe("talk.client.transcript sender attribution", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-sender-")));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    await cleanupSessionStateForTest({ stateDir: tempDir });
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("attributes spoken user entries to the authenticated profile that sent them", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const client = {
      connId: "conn-speaker",
      authenticatedUserProfile: { profileId: "profile-speaker", displayName: "Ada Lovelace" },
    };
    for (const [entryId, role] of [
      ["1", "user"],
      ["2", "assistant"],
    ] as const) {
      const respond = vi.fn();
      await talkClientHandlers["talk.client.transcript"]?.({
        params: { sessionKey, voiceSessionId, entryId, role, text: `${role} words`, timestamp: 1 },
        respond,
        context: { getRuntimeConfig: () => ({}) },
        client,
      } as never);
      expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    }

    const events = readSessionTranscriptMessageEvents({ agentId: "main", sessionId });
    expect(events[0]?.event).toHaveProperty("message.__openclaw", {
      senderId: "profile-speaker",
      senderName: "Ada Lovelace",
      senderIdentity: { type: "profile", id: "profile-speaker" },
    });
    expect(events[1]?.event).not.toHaveProperty("message.__openclaw");
  });
});
