// The host owns aggregate snapshots from opted-in prompt hooks.
import type { CustomMessage } from "./sessions/messages.js";

export const PLUGIN_PROMPT_CONTEXT_TYPE = "openclaw-plugin-prompt-context";

function isSnapshot(message: unknown): message is CustomMessage<string> {
  return (
    message !== null &&
    typeof message === "object" &&
    (message as CustomMessage).role === "custom" &&
    (message as CustomMessage).customType === PLUGIN_PROMPT_CONTEXT_TYPE
  );
}

export function hasPluginPromptContextSnapshot(messages: readonly unknown[]): boolean {
  return messages.some(isSnapshot);
}

// undefined: this path did not evaluate hooks (e.g. raw/settled-turn paths).
// null: hooks were evaluated but supplied no current persistent context.
export function buildPluginPromptContextSnapshot(
  text: string | null | undefined,
  messages: readonly unknown[] = [],
  hasSummarizedContext = false,
): CustomMessage<string> | undefined {
  if (text === undefined) {
    return undefined;
  }
  let currentContext = text;
  if (!text?.trim()) {
    if (!hasPluginPromptContextSnapshot(messages) && !hasSummarizedContext) {
      return undefined;
    }
    currentContext =
      "Earlier persistent plugin context snapshots are historical only and no longer current. Use fresh context supplied for this turn if available; otherwise reacquire current context before relying on their state. Retiring these snapshots does not mean that a case or resource does not exist.";
  }
  return {
    role: "custom",
    customType: PLUGIN_PROMPT_CONTEXT_TYPE,
    display: false,
    content:
      "Plugin context state update. This state remains current in later turns until a newer plugin context state update replaces it. No new update means the state is unchanged. For current state, use the latest retained update; earlier updates are historical.\n" +
      currentContext,
    details: "experimental-plugin-context",
    timestamp: Date.now(),
  };
}

// The native owner calls this before budgeting and again after pre-prompt compaction.
// Selection follows retained session state, so a removed snapshot is restored.
export function deduplicatePluginPromptContext<T>(messages: readonly unknown[], pending: T[]): T[] {
  let previous = messages.findLast(isSnapshot);
  return pending.filter((message) => {
    if (!isSnapshot(message)) {
      return true;
    }
    const duplicate = previous?.content === message.content;
    previous = message;
    return !duplicate;
  });
}
