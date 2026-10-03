import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { Context, Model } from "../../../llm/types.js";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
} from "../../../plugin-sdk/plugin-test-runtime.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { resolvePendingRuntimeContextReplay } from "../../internal-runtime-context.js";
import { PLUGIN_PROMPT_CONTEXT_TYPE } from "../../plugin-prompt-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createCompactionRequestBudget } from "../../sessions/compaction/request-budget.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
} from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

registerAgentSessionLoopTestLifecycle();

const RETIREMENT_PREFIX = "Earlier persistent plugin context snapshots are historical only";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type PluginState = {
  mode: "persistent" | "transient" | "silent";
  persistentText: string;
  transientText: string;
};

type Fixture = Awaited<ReturnType<typeof createFixture>>;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createFixture(fixtureOptions: { allowPromptInjection?: boolean } = {}) {
  const stateDir = tempDirs.make("openclaw-persistent-plugin-context-");
  const pluginState: PluginState = {
    mode: "persistent",
    persistentText: "CONTEXT_VERSION_1",
    transientText: "FRESH_TRANSIENT_CONTEXT",
  };
  const runtime = createPluginRuntimeMock();
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: stateDir } },
    plugins: {
      entries: {
        "context-fixture": {
          enabled: true,
          hooks: {
            allowConversationAccess: true,
            allowPromptInjection: fixtureOptions.allowPromptInjection ?? true,
          },
        },
      },
    },
  };
  runtime.config.current = () => config;
  const builder = createPluginRegistry({
    logger: { debug() {}, error() {}, info() {}, warn() {} },
    runtime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "context-fixture",
    hookNames: ["before_prompt_build"],
    origin: "config",
    source: "test/persistent-plugin-context-fixture.ts",
    status: "loaded",
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, {
    config,
    hookPolicy: {
      allowConversationAccess: true,
      allowPromptInjection: fixtureOptions.allowPromptInjection ?? true,
    },
  });
  api.on("before_prompt_build", (event) => {
    if (!event.persistentContextSupported || pluginState.mode === "silent") {
      return undefined;
    }
    if (pluginState.mode === "transient") {
      return { prependContext: pluginState.transientText };
    }
    return { persistentContext: pluginState.persistentText };
  });
  const hookRunner = createHookRunner(builder.registry);
  const active = await createTestSession();
  const observedRequests: Context["messages"][] = [];
  streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
    observedRequests.push(structuredClone(context.messages));
    return createAssistantResultStream(
      createAssistant(model, [{ type: "text", text: "Synthetic completion." }]),
    );
  });
  let serial = 0;
  const compact = async (summary: string) => {
    const leaf = active.sessionManager.getLeafEntry();
    if (!leaf) {
      throw new Error("Expected a submitted turn before compaction.");
    }
    await withSessionManagerWrite(active.sessionManager, () =>
      active.sessionManager.appendCompaction(summary, leaf.id, 1),
    );
    active.session.agent.state.messages = active.sessionManager.buildSessionContext().messages;
  };

  const runTurn = async (
    prompt: string,
    options: { compactAfterPreparation?: boolean; raw?: boolean } = {},
  ) => {
    const runId = `persistent-context-${++serial}`;
    const admission = prepareSystemAgentRunAdmission(
      config,
      runId,
      "main",
      "persistent-context-integration-test",
    );
    const attempt: EmbeddedRunAttemptParams = {
      admittedRunContext: await admission.admit("embedded"),
      authStorage: active.modelRegistry.authStorage,
      authProfileStore: { profiles: {}, version: 1 },
      config,
      model: testModel,
      modelId: testModel.id,
      modelRegistry: active.modelRegistry,
      prompt,
      provider: testModel.provider,
      runId,
      sessionFile: "",
      sessionId: "persistent-plugin-context",
      sessionKey: "agent:main:persistent-plugin-context",
      sessionPersistence: "detached",
      thinkLevel: "off",
      timeoutMs: 10_000,
      transcriptPrompt: prompt,
      trigger: "user",
      workspaceDir: stateDir,
    };
    try {
      const assembly = await prepareEmbeddedAttemptPromptAssembly({
        attempt,
        activeSession: active.session,
        applyPromptBuildToolsAllow: () => [],
        diagnosticTrace: { traceId: "11111111111111111111111111111111" },
        hookAgentId: "main",
        hookRunner,
        isRawModelRun: options.raw === true,
        runtimeModel: testModel.id,
        sessionAgentId: "main",
        sessionManager: active.sessionManager,
        setActiveSessionSystemPrompt: (systemPrompt) =>
          active.session.setBaseSystemPrompt(systemPrompt),
        setLeasedSteering: () => {},
        systemPromptText: "Stable fixture instructions.",
      });
      const sessionPromptState = getEmbeddedSessionPromptState(attempt.sessionId);
      const context = await prepareEmbeddedAttemptPromptContext({
        appendOnlyRuntimeContext: true,
        attempt,
        capabilityToolNames: new Set(),
        includeBoundaryTimestamp: false,
        isRawModelRun: options.raw === true,
        messages: active.session.messages,
        prompt: assembly,
        replaceSessionMessages: (messages) => {
          active.session.agent.state.messages = messages;
        },
        sessionAgentId: "main",
        sessionVersion: 4,
        systemPromptText: "Stable fixture instructions.",
        toolResultPromptProjectionState: sessionPromptState.toolResults,
      });
      if (options.compactAfterPreparation) {
        const leaf = active.sessionManager.getLeafEntry();
        if (!leaf) {
          throw new Error("Expected the first submitted turn before compaction.");
        }
        await withSessionManagerWrite(active.sessionManager, () =>
          active.sessionManager.appendCompaction(
            "Synthetic summary without plugin state.",
            leaf.id,
            1,
          ),
        );
        active.session.agent.state.messages = active.sessionManager.buildSessionContext().messages;
      }
      const pendingContextMessages: AgentMessage[] = [];
      if (context.runtimeContextMessageForCurrentTurn) {
        pendingContextMessages.push(context.runtimeContextMessageForCurrentTurn);
      }
      if (context.pluginContextMessageForCurrentTurn) {
        pendingContextMessages.push(context.pluginContextMessageForCurrentTurn);
      }
      const queuedContext = resolvePendingRuntimeContextReplay({
        messages: active.session.messages,
        pendingContextMessages,
      }).pendingContextMessages;
      const compactionRequestBudget = createCompactionRequestBudget({
        contextWindow: testModel.contextWindow,
        pendingPrompt: context.llmBoundaryPromptForPrecheck,
        pendingAdditivePrompt: [
          assembly.promptBuildPrependContext,
          assembly.promptBuildAppendContext,
        ]
          .filter(Boolean)
          .join("\n\n"),
        pendingQueuedContextMessages: queuedContext,
        reserveTokens: testModel.maxTokens,
        systemPrompt: "Stable fixture instructions.",
        tools: active.session.agent.state.tools,
      });
      await submitEmbeddedAttemptPrompt({
        activeSession: active.session,
        prependContext: assembly.promptBuildPrependContext,
        appendContext: assembly.promptBuildAppendContext,
        appendOnlyRuntimeContext: true,
        attempt,
        compactionRequestBudget,
        contextTokenBudget: testModel.contextWindow,
        images: [],
        modelPrompt: context.promptForModel,
        onFinalPromptText: () => {},
        onSteeringAcknowledged: () => {},
        persistToolResultProjections: async () => {},
        pluginContextMessage: context.pluginContextMessageForCurrentTurn,
        promptActiveSession: (text, promptOptions) => active.session.prompt(text, promptOptions),
        runtimeContextMessage: context.runtimeContextMessageForCurrentTurn,
        runtimeOnly: context.promptSubmission.runtimeOnly === true,
        sessionPromptState,
        systemPrompt: "Stable fixture instructions.",
        toolResultAggregateMaxChars: 8_000,
        toolResultMaxChars: 4_000,
        toolResultPromptProjectionState: sessionPromptState.toolResults,
        trajectoryRecorder: null,
        transcriptLeafId: assembly.transcriptLeafId,
        transcriptPrompt: context.promptForSession,
      });
      return { assembly, context };
    } finally {
      forgetPromptBuildDrainCacheForRun(runId);
      admission.close();
    }
  };

  const snapshots = () =>
    active.sessionManager
      .buildSessionContext()
      .messages.filter(
        (message) => message.role === "custom" && message.customType === PLUGIN_PROMPT_CONTEXT_TYPE,
      );
  const dispose = async () => {
    active.session.dispose();
    clearEmbeddedSessionPromptStates(["persistent-plugin-context"]);
    await disposePluginRegistryInstances(builder.registry);
  };
  return { compact, dispose, observedRequests, pluginState, record, runTurn, snapshots };
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  options?: { allowPromptInjection?: boolean },
) {
  const fixture = await createFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

function requestText(fixture: Fixture, index: number): string {
  return JSON.stringify(fixture.observedRequests[index]);
}

function expectStableRequestPrefix(fixture: Fixture, previous: number, next: number): void {
  const earlier = fixture.observedRequests[previous] ?? [];
  const later = fixture.observedRequests[next] ?? [];
  expect(JSON.stringify(later.slice(0, earlier.length))).toBe(JSON.stringify(earlier));
}

describe("persistent plugin prompt context", () => {
  it("deduplicates unchanged state, appends an update, then retires it while retaining fresh transient context", async () => {
    await withFixture(async (fixture) => {
      await fixture.runTurn("First request.");
      await fixture.runTurn("Second request.");
      fixture.pluginState.persistentText = "CONTEXT_VERSION_2";
      await fixture.runTurn("Third request.");
      fixture.pluginState.mode = "transient";
      await fixture.runTurn("Use fresh transient state.");

      expect(fixture.record.hookCount).toBe(1);
      expectStableRequestPrefix(fixture, 0, 1);
      expectStableRequestPrefix(fixture, 1, 2);
      expectStableRequestPrefix(fixture, 2, 3);
      expect(fixture.snapshots().map((message) => message.content)).toEqual([
        expect.stringContaining("CONTEXT_VERSION_1"),
        expect.stringContaining("CONTEXT_VERSION_2"),
        expect.stringContaining(RETIREMENT_PREFIX),
      ]);
      expect(requestText(fixture, 1)).toContain("CONTEXT_VERSION_1");
      expect(requestText(fixture, 2)).toContain("CONTEXT_VERSION_2");
      expect(fixture.snapshots()[2]?.content).not.toContain("CONTEXT_VERSION_2");
      expect(requestText(fixture, 3)).toContain("FRESH_TRANSIENT_CONTEXT");
      expect(requestText(fixture, 3)).toContain(RETIREMENT_PREFIX);
    });
  });

  it("restores current state after compaction and preserves it when a raw path skips hooks", async () => {
    await withFixture(async (fixture) => {
      await fixture.runTurn("Record durable state.");
      await fixture.runTurn("Continue after compaction.", { compactAfterPreparation: true });
      const rawResult = await fixture.runTurn("Exact raw request.", { raw: true });

      expect(fixture.snapshots()).toHaveLength(1);
      expect(fixture.snapshots()[0]?.content).toContain("CONTEXT_VERSION_1");
      expect(requestText(fixture, 1)).toContain("CONTEXT_VERSION_1");
      expect(rawResult.assembly.persistentContext).toBeUndefined();
      expect(requestText(fixture, 2)).not.toContain(RETIREMENT_PREFIX);
    });
  });

  it("retires previous state summarized by compaction when the plugin stops contributing", async () => {
    await withFixture(async (fixture) => {
      await fixture.runTurn("Record current state.");
      await fixture.compact("The plugin previously supplied CONTEXT_VERSION_1 as current state.");
      expect(fixture.snapshots()).toHaveLength(0);
      fixture.pluginState.mode = "silent";
      await fixture.runTurn("Continue without the plugin contribution.");
      expect(requestText(fixture, 1)).toContain(RETIREMENT_PREFIX);
      expect(fixture.snapshots()).toHaveLength(1);
    });
  });

  it("does not persist a snapshot when the plugin lacks prompt-injection authority", async () => {
    await withFixture(
      async (fixture) => {
        await fixture.runTurn("Attempt contextual request.");

        expect(fixture.record.hookCount).toBe(0);
        expect(fixture.snapshots()).toHaveLength(0);
        expect(requestText(fixture, 0)).not.toContain("CONTEXT_VERSION_1");
      },
      { allowPromptInjection: false },
    );
  });
});
