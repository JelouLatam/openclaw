import { afterEach, expect, it, vi } from "vitest";
import { buildConfiguredAgentSystemPrompt } from "../../system-prompt-config.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { prepareAttemptSystemPromptAdditions } from "./attempt-system-prompt-additions.js";

vi.mock("../../../infra/device-pairing.js", () => ({
  hasPairedCardRenderer: vi.fn(async () => false),
}));

vi.mock("../../../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

const sessionId = "completion-context-session";
const conversationContext = [
  "### Message Context",
  "```json",
  '{ "channel": "whatsapp", "chat_type": "group" }',
  "```",
  "",
  "Reply only when the group addresses you.",
].join("\n");

afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));

async function renderSystemPrompt(
  turn: Pick<
    Parameters<typeof prepareAttemptSystemPromptAdditions>[0],
    "extraSystemPrompt" | "inputProvenance" | "silentReplyPromptMode" | "trigger"
  >,
) {
  const additions = await prepareAttemptSystemPromptAdditions({
    agentId: "main",
    modelId: "claude-sonnet-5",
    provider: "anthropic",
    sessionId,
    sessionKey: "agent:main:whatsapp:group:fixture",
    ...turn,
  });
  return buildConfiguredAgentSystemPrompt({
    workspaceDir: "/tmp/openclaw-completion-context",
    reasoningTagHint: false,
    runtimeInfo: {
      host: "fixture-host",
      os: "linux",
      arch: "arm64",
      node: "v24.14.0",
      model: "anthropic/claude-sonnet-5",
      channel: "whatsapp",
      chatType: "group",
    },
    toolNames: ["exec", "message", "sessions_spawn"],
    userTimezone: "UTC",
    userDate: "2026-10-05",
    extraSystemPrompt: additions.extraSystemPrompt,
    silentReplyPromptMode: additions.silentReplyPromptMode,
  });
}

it("renders a completion report with the system prompt of the user turn it follows", async () => {
  const completionReport = {
    trigger: "user" as const,
    inputProvenance: {
      kind: "inter_session" as const,
      sourceTool: "subagent_settle",
      sourceSessionKey: "agent:main:subagent:child",
    },
  };
  const withoutUserTurn = await renderSystemPrompt(completionReport);
  const userTurn = await renderSystemPrompt({
    trigger: "user",
    extraSystemPrompt: conversationContext,
    silentReplyPromptMode: "none",
  });
  const afterUserTurn = await renderSystemPrompt(completionReport);

  expect(userTurn).toContain(`## Conversation Context\n${conversationContext}`);
  expect(withoutUserTurn).not.toContain(conversationContext);
  expect(afterUserTurn).toBe(userTurn);
});
