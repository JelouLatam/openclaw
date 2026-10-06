import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import { describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../../llm/types.js";
import {
  buildInterSessionPromptContext,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import type { AgentMessage } from "../runtime/index.js";
import { convertToLlm } from "../sessions/messages.js";
import type { SessionManager } from "../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import type { TranscriptPolicy } from "../transcript-policy.js";
import { sanitizeSessionHistory } from "./replay-history.js";
import { normalizeMessagesForLlmBoundary } from "./run/attempt-llm-boundary.js";
import { buildRuntimeContextCustomMessage } from "./run/runtime-context-prompt.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  sanitizeProviderReplayHistoryWithPlugin: async (params: { context: { messages: unknown } }) =>
    params.context.messages,
  validateProviderReplayTurnsWithPlugin: () => undefined,
}));

const TS = Date.UTC(2026, 9, 6, 1, 29, 22);
const model = {
  id: "claude-sonnet-5-5",
  name: "Synthetic completion report fixture",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 2_048,
} satisfies Model<"anthropic-messages">;
const claudePolicy: TranscriptPolicy = {
  sanitizeMode: "full",
  sanitizeToolCallIds: true,
  toolCallIdMode: "strict",
  preserveNativeAnthropicToolUseIds: true,
  repairToolUseResultPairing: true,
  preserveSignatures: true,
  appendOnlyRuntimeContext: true,
  dropThinkingBlocks: false,
  applyGoogleTurnOrdering: false,
  validateGeminiTurns: false,
  validateAnthropicTurns: true,
  allowSyntheticToolResults: false,
};
const settle: InputProvenance = {
  kind: "inter_session",
  sourceSessionKey: "agent:atlas:subagent:child",
  sourceChannel: "internal",
  sourceTool: "subagent_settle",
};
const report = "[Subagent Context] Every subagent in this batch has now settled.";
const sessionManager = {
  getEntries: () => [],
  getBranch: () => [],
  appendCustomEntry: () => undefined,
} as unknown as SessionManager;

function carrier(text: string, timestamp: number): AgentMessage {
  return { ...buildRuntimeContextCustomMessage(text)!, timestamp };
}

function assistant(
  content: Parameters<typeof makeAgentAssistantMessage>[0]["content"],
  at: number,
) {
  return makeAgentAssistantMessage({
    api: "anthropic-messages",
    provider: "anthropic",
    model: model.id,
    content,
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: at,
  });
}

// The Control UI turn that spawns a child and yields until it settles.
const operatorTurn: AgentMessage[] = [
  { role: "user", content: "Spawn a helper that counts SKILL.md files and wait.", timestamp: TS },
  carrier("## Active Subagents\nnone", TS),
  assistant(
    [{ type: "toolCall", id: "toolu_yield", name: "sessions_yield", arguments: {} }],
    TS + 1,
  ),
  {
    role: "toolResult",
    toolCallId: "toolu_yield",
    toolName: "sessions_yield",
    content: [{ type: "text", text: '{"status":"yielded"}' }],
    isError: false,
    timestamp: TS + 2,
  },
];

// attempt-prompt-build sends the settle report bare and moves its envelope into the carrier.
const reportTurn: AgentMessage[] = [
  { role: "user", content: report, provenance: settle, timestamp: TS + 10_000 } as AgentMessage,
  carrier(
    [...buildInterSessionPromptContext(settle).fragments.map((f) => f.text), "- result: 55"].join(
      "\n\n",
    ),
    TS + 10_000,
  ),
];

async function history(messages: AgentMessage[], policy = claudePolicy) {
  return await sanitizeSessionHistory({
    messages,
    modelApi: model.api,
    provider: model.provider,
    modelId: model.id,
    sessionManager,
    sessionId: "completion-report-fixture",
    policy,
  });
}

async function wireMessages(messages: AgentMessage[]): Promise<unknown[]> {
  let captured: { messages: unknown[] } | undefined;
  const context: Context = {
    systemPrompt: "Stable system prompt",
    messages: convertToLlm(
      normalizeMessagesForLlmBoundary(messages, {
        appendOnlyRuntimeContext: true,
        timezone: "UTC",
      }),
    ),
  };
  const result = await streamAnthropic(model, context, {
    apiKey: "synthetic-no-network",
    cacheRetention: "short",
    onPayload(value) {
      captured = structuredClone(value) as { messages: unknown[] };
      throw new Error("WIRE_CAPTURE_ONLY");
    },
  }).result();
  expect(result.errorMessage).toContain("WIRE_CAPTURE_ONLY");
  return JSON.parse(
    JSON.stringify(captured?.messages, (key, value) =>
      key === "cache_control" ? undefined : value,
    ),
  ) as unknown[];
}

describe("completion report replay on Claude routes", () => {
  it("replays a settled report with the bytes its live turn sent", async () => {
    const live = await wireMessages([...(await history(operatorTurn)), ...reportTurn]);
    const nextTurn = await wireMessages([
      ...(await history([
        ...operatorTurn,
        ...reportTurn,
        assistant([{ type: "text", text: "55" }], TS + 11_000),
      ])),
      { role: "user", content: "Thanks.", timestamp: TS + 20_000 },
    ]);

    expect(nextTurn.slice(0, live.length)).toEqual(live);
  });

  it("keeps the replay envelope when the carrier does not reach the model", async () => {
    const replayed = await history(reportTurn, {
      ...claudePolicy,
      appendOnlyRuntimeContext: false,
    });
    const bare = await history(reportTurn.slice(0, 1));

    expect(replayed[0]).toMatchObject({
      content: expect.stringMatching(/^\[Inter-session message\]/),
    });
    expect(bare[0]).toMatchObject({ content: expect.stringMatching(/^\[Inter-session message\]/) });
  });
});
