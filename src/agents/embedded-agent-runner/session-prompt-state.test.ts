import { afterEach, describe, expect, it } from "vitest";
import {
  clearEmbeddedSessionPromptStates,
  prepareEmbeddedSessionActiveProjectKeys,
  resolveEmbeddedSessionConversationContext,
} from "./session-prompt-state.js";

const sessionIds = new Set<string>();

function prepare(sessionId: string, projectKey: string | null): readonly string[] {
  sessionIds.add(sessionId);
  return prepareEmbeddedSessionActiveProjectKeys(sessionId, projectKey);
}

afterEach(() => {
  clearEmbeddedSessionPromptStates(sessionIds);
  sessionIds.clear();
});

describe("embedded session active project keys", () => {
  it("promotes repeated keys while retaining other recently active projects", () => {
    expect(prepare("session-lru", "repo-a")).toEqual(["repo-a"]);
    expect(prepare("session-lru", "repo-b")).toEqual(["repo-b", "repo-a"]);
    expect(prepare("session-lru", "repo-a")).toEqual(["repo-a", "repo-b"]);
  });

  it("evicts the least-recent project beyond the four-key cap", () => {
    for (const key of ["repo-a", "repo-b", "repo-c", "repo-d", "repo-e"]) {
      prepare("session-cap", key);
    }
    expect(prepare("session-cap", null)).toEqual(["repo-e", "repo-d", "repo-c", "repo-b"]);
  });

  it("keeps single-repository sessions identical and isolated", () => {
    expect(prepare("session-one", "repo-a")).toEqual(["repo-a"]);
    expect(prepare("session-one", null)).toEqual(["repo-a"]);
    expect(prepare("session-two", null)).toEqual([]);
  });
});

describe("embedded session conversation context", () => {
  const userTurnContext = "### Message Context\nchannel: webchat";

  function resolve(
    sessionId: string,
    turn: Omit<Parameters<typeof resolveEmbeddedSessionConversationContext>[0], "sessionId">,
  ) {
    sessionIds.add(sessionId);
    return resolveEmbeddedSessionConversationContext({ sessionId, ...turn });
  }

  function completionReport(sourceTool = "subagent_settle") {
    return {
      trigger: "user" as const,
      inputProvenance: {
        kind: "inter_session" as const,
        sourceTool,
        sourceSessionKey: "agent:main:subagent:child",
      },
    };
  }

  it("lends a user turn's context to the completion reports that follow it", () => {
    resolve("session-context", {
      trigger: "user",
      extraSystemPrompt: userTurnContext,
      silentReplyPromptMode: "none",
    });
    for (const sourceTool of ["subagent_settle", "subagent_announce", "image_generate"]) {
      expect(resolve("session-context", completionReport(sourceTool))).toEqual({
        extraSystemPrompt: userTurnContext,
        silentReplyPromptMode: "none",
      });
    }
    expect(
      resolve("session-context", { ...completionReport(), silentReplyPromptMode: "generic" }),
    ).toEqual({ extraSystemPrompt: userTurnContext, silentReplyPromptMode: "generic" });
  });

  it("leaves other turns, other sessions, and caller-supplied context alone", () => {
    resolve("session-owner", { trigger: "user", extraSystemPrompt: userTurnContext });
    const caller = { ...completionReport(), extraSystemPrompt: "caller context" };
    expect(resolve("session-owner", caller).extraSystemPrompt).toBe("caller context");
    expect(resolve("session-other", completionReport())).toEqual({});
    expect(
      resolve("session-owner", {
        trigger: "user",
        inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
    ).toEqual({});
    for (const trigger of ["heartbeat", "cron", "memory", "manual"] as const) {
      resolve("session-owner", { trigger, extraSystemPrompt: `${trigger} prompt` });
      expect(resolve("session-owner", { trigger })).toEqual({});
    }
    expect(resolve("session-owner", completionReport()).extraSystemPrompt).toBe(userTurnContext);
  });

  it("follows the latest user turn and forgets cleared sessions", () => {
    resolve("session-latest", { trigger: "user", extraSystemPrompt: userTurnContext });
    resolve("session-latest", { trigger: "user", inputProvenance: { kind: "external_user" } });
    expect(resolve("session-latest", completionReport())).toEqual({});
    resolve("session-latest", { trigger: "user", extraSystemPrompt: userTurnContext });
    clearEmbeddedSessionPromptStates(["session-latest"]);
    expect(resolve("session-latest", completionReport())).toEqual({});
  });
});
