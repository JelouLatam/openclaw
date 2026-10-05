import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import { mirrorDeliveredPayloads } from "./deliver-transcript.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(
    async (_params: Record<string, unknown>) => ({ ok: true }) as const,
  ),
  appendDeliveryMirrorToSessionTranscript: vi.fn(
    async (_params: Record<string, unknown>) => ({ ok: true }) as const,
  ),
}));

vi.mock("../../config/sessions/transcript.runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../config/sessions/transcript.runtime.js")
  >("../../config/sessions/transcript.runtime.js");
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});

vi.mock("./delivery-mirror-media.runtime.js", () => ({
  appendDeliveryMirrorToSessionTranscript: mocks.appendDeliveryMirrorToSessionTranscript,
}));

const SESSION_KEY = "agent:atlas:whatsapp:group:120363000000000000@g.us";

async function mirror(payloads: NormalizedOutboundPayload[]): Promise<void> {
  await mirrorDeliveredPayloads({
    delivery: {
      cfg: {},
      mirror: { agentId: "atlas", sessionKey: SESSION_KEY, idempotencyKey: "send-1" },
    } as unknown as DeliverOutboundPayloadsCoreParams,
    payloads,
    channel: "whatsapp",
    to: "120363000000000000@g.us",
  });
}

describe("outbound delivery mirror media", () => {
  beforeEach(() => {
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.appendDeliveryMirrorToSessionTranscript.mockClear();
  });

  it("hands the sent files to the media mirror instead of flattening them to filenames", async () => {
    await mirror([
      { text: "Ad Jelou 1:1", mediaUrls: ["/data/workspaces/atlas/reports/ad-1x1.mp4"] },
    ]);

    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.appendDeliveryMirrorToSessionTranscript.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: SESSION_KEY,
      agentId: "atlas",
      text: "Ad Jelou 1:1",
      mediaUrls: ["/data/workspaces/atlas/reports/ad-1x1.mp4"],
      idempotencyKey: "send-1",
    });
  });

  it("keeps text-only mirrors on the plain transcript append", async () => {
    await mirror([{ text: "Listo", mediaUrls: [] }]);

    expect(mocks.appendDeliveryMirrorToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript.mock.calls[0]?.[0]).toMatchObject({
      text: "Listo",
    });
    expect(mocks.appendAssistantMessageToSessionTranscript.mock.calls[0]?.[0]).not.toHaveProperty(
      "mediaUrls",
    );
  });
});
