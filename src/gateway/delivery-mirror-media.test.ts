import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { appendDeliveryMirrorToSessionTranscript } from "./delivery-mirror-media.js";
import { listManagedImageRecordEntries } from "./managed-image-record-store.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const TINY_PDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";

async function createMirrorFixture(state: OpenClawTestState) {
  const sessionKey = "agent:main:whatsapp:group:120363000000000000@g.us";
  const scope = {
    agentId: "main",
    sessionKey,
    sessionId: "delivery-mirror-media-session",
    storePath: path.join(state.stateDir, "agents", "main", "sessions", "sessions.json"),
  };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await fs.mkdir(path.join(state.workspaceDir, "reports"), { recursive: true });
  const imagePath = path.join(state.workspaceDir, "reports", "ilustracion-742x500@2x.png");
  const documentPath = path.join(state.workspaceDir, "reports", "propuesta.pdf");
  await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
  await fs.writeFile(documentPath, TINY_PDF);
  const lastMessage = async () => {
    const events = await loadTranscriptEvents(scope);
    const message = readTranscriptEventMessage(events.at(-1));
    return message as Record<string, unknown> | undefined;
  };
  const records = () => listManagedImageRecordEntries({ stateDir: state.stateDir, sessionKey });
  return { scope, imagePath, documentPath, lastMessage, records };
}

describe("delivery mirror media", () => {
  it("keeps the files a channel send carried as attachments the Control UI renders", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "delivery-mirror-media-" },
      async (state) => {
        const fixture = await createMirrorFixture(state);

        const result = await appendDeliveryMirrorToSessionTranscript({
          agentId: "main",
          sessionKey: fixture.scope.sessionKey,
          expectedSessionId: fixture.scope.sessionId,
          text: "Ilustraciones listas",
          mediaUrls: [fixture.imagePath, fixture.documentPath],
          idempotencyKey: "send-1",
          config: { agents: { defaults: { workspace: state.workspaceDir } } },
        });

        expect(result.ok).toBe(true);
        const message = await fixture.lastMessage();
        expect(message).toMatchObject({
          role: "assistant",
          model: "delivery-mirror",
          content: [
            {
              type: "text",
              text: "Ilustraciones listas\nilustracion-742x500@2x.png, propuesta.pdf",
            },
          ],
          openclawDelivery: { mediaUrls: [fixture.imagePath, fixture.documentPath] },
        });
        const display = message?.openclawDisplayContent as Array<Record<string, unknown>>;
        expect(display[0]).toEqual({ type: "text", text: "Ilustraciones listas" });
        expect(display.slice(1).map((block) => block.type)).toEqual(["image", "attachment"]);
        for (const block of display.slice(1)) {
          expect(JSON.stringify(block)).toContain("/api/chat/media/outgoing/");
        }
        const records = await fixture.records();
        expect(records).toHaveLength(2);
        for (const { record } of records) {
          expect(record.messageId).toEqual(expect.any(String));
        }
      },
    );
  });

  it("writes the text-only mirror when no sent file can be read back", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "delivery-mirror-media-missing-" },
      async (state) => {
        const fixture = await createMirrorFixture(state);
        const missing = path.join(state.workspaceDir, "reports", "borrado.mp4");

        const result = await appendDeliveryMirrorToSessionTranscript({
          agentId: "main",
          sessionKey: fixture.scope.sessionKey,
          expectedSessionId: fixture.scope.sessionId,
          text: "Ad listo",
          mediaUrls: [missing, "https://cdn.example.com/ad.mp4"],
          config: { agents: { defaults: { workspace: state.workspaceDir } } },
        });

        expect(result.ok).toBe(true);
        const message = await fixture.lastMessage();
        expect(message).toMatchObject({
          content: [{ type: "text", text: "Ad listo\nborrado.mp4, ad.mp4" }],
        });
        expect(message).not.toHaveProperty("openclawDisplayContent");
        expect(await fixture.records()).toEqual([]);
      },
    );
  });
});
