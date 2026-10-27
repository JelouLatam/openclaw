import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import { createHostSandboxFsBridge } from "../../agents/test-helpers/host-sandbox-fs-bridge.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";

const sandboxMocks = vi.hoisted(() => ({ resolveContext: vi.fn() }));
vi.mock("../../agents/sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sandbox.js")>()),
  resolveSandboxContext: sandboxMocks.resolveContext,
}));
afterEach(() => sandboxMocks.resolveContext.mockReset());

it.each(["success", "transfer-failure", "cancelled"] as const)(
  "prepares a WebChat upload in an existing SSH workspace: %s",
  async (outcome) => {
    await withOpenClawTestState({ label: "chat-ssh-upload" }, async (state) => {
      const remote = state.path("worker");
      await fs.mkdir(remote);
      await fs.writeFile(path.join(remote, "existing-project.txt"), "keep remote edits");
      const bridge = createHostSandboxFsBridge(remote);
      const create = bridge.createFileExclusive!.bind(bridge);
      const controller = new AbortController();
      const abort = new Error("upload cancelled");
      bridge.createFileExclusive = async (params) => {
        if (!params.filePath.endsWith("/.gitignore")) {
          if (outcome === "transfer-failure") {
            throw new Error("worker unavailable");
          }
          if (outcome === "cancelled") {
            controller.abort(abort);
            throw abort;
          }
        }
        params.signal?.throwIfAborted();
        return create(params);
      };
      sandboxMocks.resolveContext.mockResolvedValue({
        backendId: "ssh",
        workspaceDir: state.workspaceDir,
        fsBridge: bridge,
      } as Partial<SandboxContext>);
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode: "all" as const,
              backend: "ssh",
              scope: "agent" as const,
              workspaceRoot: state.path("sandboxes"),
              workspaceAccess: "rw" as const,
              ssh: { target: "sandbox@fixture.invalid", workspaceRoot: "/worker" },
            },
          },
        },
      };
      const bytes = "Synthetic partner document. The demo needs a catalog and reservations.";
      const request = normalizeChatSendRequest({
        client: null,
        params: {
          agentId: "main",
          sessionKey: "agent:main:main",
          message: "read my document",
          idempotencyKey: `upload-${outcome}`,
          attachments: [
            {
              fileName: "brief café.docx",
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              content: Buffer.from(bytes).toString("base64"),
            },
          ],
        },
      });
      if (!request.ok) {
        throw new Error(request.error);
      }
      const respond = vi.fn();
      const finishAbortedChatSend = vi.fn();
      const result = await prepareChatSendAttachments({
        request: request.value,
        session: {
          cfg,
          sessionKey: "agent:main:main",
          agentId: "main",
          resolvedSessionModel: { provider: "fixture", model: "fixture" },
          clientRunId: `upload-${outcome}`,
        },
        admission: {
          activeRunAbort: { controller, cleanup() {} },
          assertWorkAdmissionCurrent: () => controller.signal.throwIfAborted(),
          cleanupAdmittedRun() {},
          finishAbortedChatSend,
        },
        context: {
          logGateway: createSubsystemLogger("test/chat-ssh-upload"),
          chatRunState: { hasAbortMarker: () => controller.signal.aborted },
        },
        respond,
      } as unknown as Parameters<typeof prepareChatSendAttachments>[0]);
      expect(await fs.readFile(path.join(remote, "existing-project.txt"), "utf8")).toBe(
        "keep remote edits",
      );
      if (outcome !== "success") {
        expect(result.ok).toBe(false);
        if (outcome === "cancelled") {
          expect(finishAbortedChatSend).toHaveBeenCalledOnce();
        } else {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "UNAVAILABLE" }),
          );
        }
        return;
      }
      expect(respond).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("attachment preparation failed");
      }
      const media = result.value.mediaPathOffloads[0]!;
      expect(media.fileName).toBe("brief café.docx");
      expect(path.isAbsolute(media.path!)).toBe(false);
      expect(await fs.readFile(path.join(remote, media.path!), "utf8")).toBe(bytes);
      expect(
        await fs.readFile(path.join(remote, path.dirname(media.path!), ".gitignore"), "utf8"),
      ).toContain("Raw task inputs remain private");
      await expect(fs.stat(path.join(state.workspaceDir, media.path!))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readFile(result.value.offloadedRefs[0]!.path, "utf8")).toBe(bytes);
    });
  },
);
