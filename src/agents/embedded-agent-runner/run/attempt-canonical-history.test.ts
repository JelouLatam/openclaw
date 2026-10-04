import path from "node:path";
import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import { ensureSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../../../auto-reply/reply/inbound-context.js";
import { buildInboundUserContextFragment } from "../../../auto-reply/reply/inbound-user-context-fragment.js";
import { buildReplyPromptEnvelopeBase } from "../../../auto-reply/reply/prompt-prelude.js";
import { mergeSessionTranscriptContext } from "../../../channels/inbound-event/session-transcript-context.runtime.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { readRecentUserAssistantTextForSession } from "../../../config/sessions/transcript.js";
import type { Context, Model } from "../../../llm/types.js";
import {
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
} from "../../../plugin-sdk/plugin-test-runtime.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import {
  attachCanonicalHistorySource,
  canonicalHistoryFingerprint,
  readCanonicalHistorySource,
} from "../../../shared/canonical-history.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { resolvePendingRuntimeContextReplay } from "../../internal-runtime-context.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../../sessions/agent-session-loop-resource-loader.test-support.js";
import { createCompactionRequestBudget } from "../../sessions/compaction/request-budget.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  getEmbeddedSessionPromptState,
  clearEmbeddedSessionPromptStates,
} from "../session-prompt-state.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
} from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import {
  buildRuntimeContextCustomMessage,
  projectPendingCanonicalHistory,
} from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  vi.unstubAllGlobals();
  clearEmbeddedSessionPromptStates(["canonical-history-fixture"]);
});
const model = {
  id: "claude-sonnet-4-6",
  name: "Synthetic canonical history fixture",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 2_048,
} satisfies Model<"anthropic-messages">;
type Payload = { system?: unknown; tools?: unknown; messages: unknown[] };
const canonical = (value: unknown) =>
  JSON.stringify(value, (key, item) => {
    if (key === "cache_control") {
      return undefined;
    }
    if (item && ["user", "assistant"].includes(item.role) && typeof item.content === "string") {
      return { ...item, content: [{ type: "text", text: item.content }] };
    }
    return item;
  });
const occurrences = (value: unknown, marker: string) => canonical(value).split(marker).length - 1;

async function captureWire(context: Context): Promise<Payload> {
  let captured: Payload | undefined;
  const result = await streamAnthropic(model, context, {
    apiKey: "synthetic-no-network",
    cacheRetention: "short",
    thinkingEnabled: true,
    onPayload(value) {
      captured = structuredClone(value) as Payload;
      throw new Error("HISTORY_CAPTURE_ONLY");
    },
  }).result();
  expect(result.errorMessage).toContain("HISTORY_CAPTURE_ONLY");
  expect(captured).toBeDefined();
  return captured!;
}

describe("Canonical channel history at the provider boundary", () => {
  it("omits retained copies and restores compacted history without changing signed prefixes", async () => {
    await withOpenClawTestState(
      { label: "canonical-history-native", agentEnv: "clear" },
      async (state) => {
        const stateDir = state.stateDir;
        const fetchGuard = vi.fn(() => {
          throw new Error("NETWORK_FORBIDDEN");
        });
        vi.stubGlobal("fetch", fetchGuard);
        const payloads: Payload[] = [];
        const historyReads: Array<{
          canonicalEntries: number;
        }> = [];
        const sessions: Array<Awaited<ReturnType<typeof createTestSession>>["session"]> = [];
        const baseSystem = ensureSystemPromptCacheBoundary(
          "Use only the synthetic group evidence. Preserve old and changed facts.",
        );
        const loader = createResourceLoader();
        loader.getSystemPrompt = () => baseSystem;
        const config = { agents: { defaults: { workspace: stateDir } } };
        const runtime = createPluginRuntimeMock();
        runtime.state.resolveStateDir = () => stateDir;
        runtime.config.current = () => config;
        const registry = createPluginRegistry({
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          runtime,
          activateGlobalSideEffects: false,
        });
        const hookRunner = createHookRunner(registry.registry, { catchErrors: false });
        const target = {
          agentId: "main",
          sessionId: "canonical-history-fixture",
          sessionKey: "agent:main:whatsapp:group:synthetic-history",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        let calls = 0;
        streamMocks.streamSimple.mockImplementation((_model: Model, context: Context) => {
          const stream = createAssistantMessageEventStream();
          void (async () => {
            payloads.push(await captureWire(context));
            const turn = ++calls;
            const message = createAssistant(model, [
              {
                type: "thinking",
                thinking: `Synthetic reasoning ${turn}.`,
                thinkingSignature: Buffer.from(`synthetic-signature-${turn}`).toString("base64"),
              },
              {
                type: "text",
                text: `SCRIPTED_REPLY_${turn} ` + "Synthetic accepted fact. ".repeat(40),
              },
            ]);
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
          })().catch((error: unknown) => {
            const message = { ...createAssistant(model, [], "error"), errorMessage: String(error) };
            stream.push({ type: "error", reason: "error", error: message });
            stream.end();
          });
          return stream;
        });
        const open = async () => {
          const manager = await SessionManager.openAsync(target, stateDir);
          const active = await createTestSession({
            model,
            sessionManager: manager,
            resourceLoader: loader,
          });
          sessions.push(active.session);
          await prepareEmbeddedAttemptSessionBoundary({
            activeSession: active.session,
            appendOnlyRuntimeContext: true,
            attempt: { prompt: "fixture", config },
            getUserTranscriptContexts: () => undefined,
            isRawModelRun: false,
            preparedUserTurnMessage: undefined,
            sessionManager: manager,
            setActiveSessionSystemPrompt: (value) => active.session.setBaseSystemPrompt(value),
          });
          return active;
        };
        try {
          await upsertSessionEntryCore(target, {
            sessionId: target.sessionId,
            updatedAt: Date.now(),
          });
          let active = await open();
          for (let turn = 1; turn <= 4; turn++) {
            if (turn === 3) {
              active.session.dispose();
              active = await open();
            }
            const text = `USER_FACT_${turn} ` + "Synthetic group decision. ".repeat(40);
            const ctx = finalizeInboundContext({
              Body: text,
              RawBody: text,
              CommandBody: text,
              From: "synthetic-group@g.us",
              To: "synthetic-group@g.us",
              Provider: "whatsapp",
              ChatType: "group",
              SessionKey: target.sessionKey,
              AgentId: "main",
              Timestamp: Date.now() + 1_000,
              MessageSid: `synthetic-message-${turn}`,
              SenderId: "synthetic-user",
              SenderName: "Synthetic participant",
              CommandAuthorized: false,
              SessionTranscriptContext: { historyLimit: 20 },
              InboundHistory:
                turn === 3
                  ? [
                      {
                        sender: "Unseen participant",
                        body: "PENDING_UNSEEN_FACT_3",
                        messageId: "session:untrusted-channel-id",
                        timestamp: Date.now(),
                      },
                    ]
                  : [],
            });
            // This is the same native backfill owner called by runPreparedChannelTurn.
            await mergeSessionTranscriptContext({
              agentId: "main",
              ctx,
              sessionKey: target.sessionKey,
              storePath: target.storePath,
            });
            const inboundFragment = buildInboundUserContextFragment(ctx);
            const inboundText = inboundFragment.text;
            const envelope = buildReplyPromptEnvelopeBase({
              ctx,
              sessionCtx: ctx,
              baseBody: text,
              hasUserBody: true,
              inboundUserContext: inboundText,
              inboundUserContextFragment: inboundFragment,
              isBareSessionReset: false,
              startupAction: "new",
            });
            historyReads.push({
              canonicalEntries:
                ctx.InboundHistory?.filter(
                  (e) =>
                    e.messageId?.startsWith("session:") &&
                    e.messageId !== "session:untrusted-channel-id",
                ).length ?? 0,
            });
            const runId = `history-run-${turn}`;
            const admission = prepareSystemAgentRunAdmission(
              config,
              runId,
              "main",
              "canonical-history-test",
            );
            try {
              const attempt: EmbeddedRunAttemptParams = {
                ...target,
                admittedRunContext: await admission.admit("embedded"),
                authStorage: active.modelRegistry.authStorage,
                authProfileStore: { version: 1, profiles: {} },
                modelRegistry: active.modelRegistry,
                prompt: text,
                runId,
                model,
                modelId: model.id,
                config,
                sessionFile: "",
                workspaceDir: stateDir,
                trigger: "user",
                provider: "anthropic",
                thinkLevel: "medium",
                timeoutMs: 10_000,
                currentInboundContext: envelope.currentInboundContext,
              };
              let systemPrompt = baseSystem;
              const assembly = await prepareEmbeddedAttemptPromptAssembly({
                attempt,
                activeSession: active.session,
                sessionManager: active.sessionManager,
                hookRunner,
                hookAgentId: "main",
                diagnosticTrace: { traceId: "22222222222222222222222222222222" },
                isRawModelRun: false,
                sessionAgentId: "main",
                runtimeModel: model.id,
                systemPromptText: baseSystem,
                applyPromptBuildToolsAllow: () => [],
                setActiveSessionSystemPrompt: (value) => {
                  systemPrompt = value;
                  active.session.setBaseSystemPrompt(value);
                },
                setLeasedSteering: () => {},
              });
              const sessionPromptState = getEmbeddedSessionPromptState(target.sessionId);
              const context = await prepareEmbeddedAttemptPromptContext({
                sessionVersion: 4,
                appendOnlyRuntimeContext: true,
                attempt,
                capabilityToolNames: new Set(),
                includeBoundaryTimestamp: false,
                isRawModelRun: false,
                messages: active.session.messages,
                prompt: assembly,
                replaceSessionMessages: (messages) => {
                  active.session.agent.state.messages = messages;
                },
                sessionAgentId: "main",
                systemPromptText: systemPrompt,
                toolResultPromptProjectionState: sessionPromptState.toolResults,
              });
              const budget = createCompactionRequestBudget({
                contextWindow: model.contextWindow,
                reserveTokens: 2_048,
                systemPrompt,
                tools: active.session.agent.state.tools,
                pendingPrompt: context.llmBoundaryPromptForPrecheck,
                pendingQueuedContextMessages: context.runtimeContextMessageForCurrentTurn
                  ? [context.runtimeContextMessageForCurrentTurn]
                  : [],
              });
              if (turn === 4) {
                const kept = active.sessionManager
                  .getBranch()
                  .findLast((entry) => entry.type === "message" && entry.message.role === "user");
                expect(kept).toBeDefined();
                await withSessionManagerWrite(active.sessionManager, () =>
                  active.sessionManager.appendCompaction(
                    "Synthetic summary without original facts",
                    kept!.id,
                    50_000,
                  ),
                );
                active.session.agent.state.messages =
                  active.sessionManager.buildSessionContext().messages;
              }
              await submitEmbeddedAttemptPrompt({
                attempt,
                activeSession: active.session,
                appendOnlyRuntimeContext: true,
                modelPrompt: context.promptForModel,
                transcriptPrompt: context.promptForSession,
                compactionRequestBudget: budget,
                runtimeContextMessage: context.runtimeContextMessageForCurrentTurn,
                contextTokenBudget: model.contextWindow,
                images: [],
                onFinalPromptText: () => {},
                onSteeringAcknowledged: () => {},
                persistToolResultProjections: async () => {},
                promptActiveSession: (prompt, options) => active.session.prompt(prompt, options),
                runtimeOnly: false,
                sessionPromptState,
                systemPrompt,
                toolResultAggregateMaxChars: 100_000,
                toolResultMaxChars: 40_000,
                toolResultPromptProjectionState: sessionPromptState.toolResults,
                trajectoryRecorder: null,
                transcriptLeafId: assembly.transcriptLeafId,
              });
            } finally {
              forgetPromptBuildDrainCacheForRun(runId);
              admission.close();
            }
          }
          const proof = {
            pendingUnseenFactOccurrences: payloads.map((p) =>
              occurrences(p.messages, "PENDING_UNSEEN_FACT_3"),
            ),
            firstUserFactOccurrences: payloads.map((p) => occurrences(p.messages, "USER_FACT_1")),
            firstAssistantFactOccurrences: payloads.map((p) =>
              occurrences(p.messages, "SCRIPTED_REPLY_1"),
            ),
            signedPrefixPreserved: payloads
              .slice(1, 3)
              .map(
                (p, index) =>
                  canonical(p.messages.slice(0, payloads[index]!.messages.length)) ===
                  canonical(payloads[index]!.messages),
              ),
            signaturesInFinalRequest: occurrences(
              payloads[2],
              Buffer.from("synthetic-signature-1").toString("base64"),
            ),
          };
          expect(payloads).toHaveLength(4);
          expect(historyReads.map((r) => r.canonicalEntries)).toEqual([0, 2, 4, 6]);
          expect(proof.firstUserFactOccurrences).toEqual([1, 1, 1, 1]);
          expect(proof.firstAssistantFactOccurrences).toEqual([0, 1, 1, 1]);
          expect(proof.pendingUnseenFactOccurrences).toEqual([0, 0, 1, 1]);
          expect(proof.signedPrefixPreserved).toEqual([true, true]);
          expect(proof.signaturesInFinalRequest).toBeGreaterThan(0);
          expect(fetchGuard).not.toHaveBeenCalled();
        } finally {
          for (const session of sessions) {
            session.dispose();
          }
          await disposePluginRegistryInstances(registry.registry);
        }
      },
    );
  });
});

describe("Canonical carrier retention boundaries", () => {
  it("does not mark derived upstream text as a retained native copy", async () => {
    await withOpenClawTestState(
      { label: "canonical-derived-text", agentEnv: "clear" },
      async (state) => {
        const target = {
          agentId: "main",
          sessionId: "derived-text-fixture",
          sessionKey: "agent:main:derived-text-fixture",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        await persistSessionTranscriptTurn(target, {
          updateMode: "none",
          messages: [
            {
              eventId: "native-user",
              message: {
                role: "user",
                content: "NATIVE_USER_CONTENT",
                timestamp: 1,
                __openclaw: { upstreamUserText: "UPSTREAM_ONLY_CONTENT" },
              },
            },
            {
              eventId: "native-assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "NATIVE_ASSISTANT_CONTENT" }],
                openclawDisplayContent: [{ type: "text", text: "DISPLAY_ONLY_CONTENT" }],
                timestamp: 2,
              },
            },
          ],
        });
        const rows = await readRecentUserAssistantTextForSession({
          ...target,
          canonicalHistoryProvenance: true,
          preferUpstreamUserText: true,
        });
        expect(rows.map((row) => row.text)).toEqual([
          "UPSTREAM_ONLY_CONTENT",
          "NATIVE_ASSISTANT_CONTENT",
        ]);
        expect(readCanonicalHistorySource(rows[0]!)).toBeUndefined();
        expect(readCanonicalHistorySource(rows[1]!)).toMatchObject({
          agentId: target.agentId,
          sessionId: target.sessionId,
          entryId: "native-assistant",
        });
      },
    );
  });

  function prepared() {
    const entry = {
      sender: "User",
      body: "CANONICAL_BOUNDARY_FACT",
      messageId: "session:entry-1",
      timestamp: 1,
    };
    const source = {
      agentId: "main",
      sessionId: "session-1",
      entryId: "entry-1",
      fingerprint: canonicalHistoryFingerprint({
        role: "user",
        content: entry.body,
        timestamp: 1,
      })!,
    };
    attachCanonicalHistorySource(entry, source);
    const fragment = buildInboundUserContextFragment({
      ChatType: "group",
      InboundHistory: [entry],
    });
    const carrier = buildRuntimeContextCustomMessage(fragment.text, [fragment])!;
    return { entry, fragment, carrier };
  }
  it("restores a pending full carrier when retention changes between budget and submit", () => {
    const { carrier } = prepared();
    const before = projectPendingCanonicalHistory(carrier, () => true);
    const after = projectPendingCanonicalHistory(carrier, () => false);
    expect(before.content).not.toContain("CANONICAL_BOUNDARY_FACT");
    expect(after.content).toContain("CANONICAL_BOUNDARY_FACT");
    expect(carrier.content).toContain("CANONICAL_BOUNDARY_FACT");
    expect(projectPendingCanonicalHistory(before, () => false)).toBe(before);
  });
  it("does not trust channel IDs or copied provenance objects", () => {
    const entry = { sender: "User", body: "UNTRUSTED_HISTORY_FACT", messageId: "session:entry-1" };
    const fragment = buildInboundUserContextFragment({
      ChatType: "group",
      InboundHistory: [entry],
    });
    const carrier = buildRuntimeContextCustomMessage(fragment.text, [fragment])!;
    expect(projectPendingCanonicalHistory(carrier, () => true).content).toContain(entry.body);
  });
  it("ignores non-serializable unowned channel metadata", () => {
    const entry: { sender: string; body: string; extra?: unknown } = {
      sender: "User",
      body: "CYCLIC_PENDING_FACT",
    };
    entry.extra = entry;
    const fragment = buildInboundUserContextFragment({
      ChatType: "group",
      InboundHistory: [entry],
    });
    const carrier = buildRuntimeContextCustomMessage(fragment.text, [fragment])!;
    expect(projectPendingCanonicalHistory(carrier, () => true).content).toContain(
      "CYCLIC_PENDING_FACT",
    );
  });
  it("keeps a source whose history data was edited after rendering", () => {
    const { entry, carrier } = prepared();
    entry.body = "CHANGED_FACT";
    expect(projectPendingCanonicalHistory(carrier, () => true).content).toContain(
      "CANONICAL_BOUNDARY_FACT",
    );
  });
  it("keeps a fragment changed by another producer", () => {
    const { fragment } = prepared();
    fragment.text += "\nEXTRA_PENDING_CONTEXT";
    const carrier = buildRuntimeContextCustomMessage(fragment.text, [fragment])!;
    const result = projectPendingCanonicalHistory(carrier, () => true);
    expect(result.content).toContain("CANONICAL_BOUNDARY_FACT");
    expect(result.content).toContain("EXTRA_PENDING_CONTEXT");
  });
  it("never promotes pending entries outside the original bounded history window", () => {
    const history = Array.from({ length: 21 }, (_, i) => ({
      sender: "User",
      body: i === 0 ? "OUTSIDE_ORIGINAL_WINDOW" : `KEPT_ORIGINAL_${i}`,
      messageId: `session:${i}`,
      timestamp: i + 1,
    }));
    for (const entry of history.slice(1)) {
      attachCanonicalHistorySource(entry, {
        agentId: "main",
        sessionId: "session-1",
        entryId: entry.messageId,
        fingerprint: canonicalHistoryFingerprint({
          role: "user",
          content: entry.body,
          timestamp: entry.timestamp,
        })!,
      });
    }
    const fragment = buildInboundUserContextFragment({
      ChatType: "group",
      InboundHistory: history,
    });
    expect(fragment.text).not.toContain("OUTSIDE_ORIGINAL_WINDOW");
    expect(fragment.text).toContain('"history_truncated":true');
    const carrier = buildRuntimeContextCustomMessage(fragment.text, [fragment])!;
    const result = projectPendingCanonicalHistory(carrier, () => true);
    expect(result.content).not.toContain("OUTSIDE_ORIGINAL_WINDOW");
    expect(result.content).not.toContain("KEPT_ORIGINAL_");
    expect(result.content).toContain('"history_truncated":true');
  });
  it("does not reproject an already persisted user/carrier retry pair", () => {
    const { carrier } = prepared();
    const projector = vi.fn((message: typeof carrier) =>
      projectPendingCanonicalHistory(message, () => true),
    );
    const result = resolvePendingRuntimeContextReplay({
      messages: [{ role: "user", idempotencyKey: "retry-1" }, carrier],
      pendingContextMessages: [carrier],
      persistedUserIdempotencyKey: "retry-1",
      projectPendingContext: projector,
    });
    expect(result.replayPersistedCarrier).toBe(true);
    expect(result.pendingContextMessages).toEqual([]);
    expect(projector).not.toHaveBeenCalled();
    expect(carrier.content).toContain("CANONICAL_BOUNDARY_FACT");
  });
});
