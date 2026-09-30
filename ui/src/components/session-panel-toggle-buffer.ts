import {
  normalizeAgentId,
  normalizeDefaultMainSessionAliasForUi,
} from "../lib/sessions/session-key.ts";

export type SessionPanelToggleSlot =
  | "browser"
  | "desktop"
  | "portal"
  | "terminal"
  | "link-reader"
  | `plugin:${string}/${string}`;

const INTENT_TTL_MS = 10_000;
const pendingToggles = new Map<
  string,
  Array<{ slot: SessionPanelToggleSlot; event: Event; createdAt: number }>
>();

function toggleKey(slot: SessionPanelToggleSlot, sessionKey?: string, agentId?: string): string {
  const session = sessionKey ? normalizeDefaultMainSessionAliasForUi(sessionKey) : "";
  if (!slot.startsWith("plugin:")) {
    return `${slot}:${session}`;
  }
  return `${slot}:${session}:${agentId ? normalizeAgentId(agentId) : ""}`;
}

export function panelToggleSessionKey(event: Event): string | undefined {
  return event instanceof CustomEvent && typeof event.detail?.sessionKey === "string"
    ? event.detail.sessionKey
    : undefined;
}

export function pluginPanelToggleAgentId(event: Event): string | undefined {
  return event instanceof CustomEvent && typeof event.detail?.agentId === "string"
    ? normalizeAgentId(event.detail.agentId)
    : undefined;
}

/**
 * The application shell exists before a session pane finishes mounting. Keep
 * the newest panel intent (all reader opens in FIFO order) so early commands reach the pane rather
 * than disappearing during route startup.
 */
export function rememberSessionPanelToggle(slot: SessionPanelToggleSlot, event: Event): void {
  const now = Date.now();
  for (const [key, queue] of pendingToggles) {
    const live = queue.filter((pending) => now - pending.createdAt <= INTENT_TTL_MS);
    if (live.length) {
      pendingToggles.set(key, live);
    } else {
      pendingToggles.delete(key);
    }
  }
  const key = toggleKey(slot, panelToggleSessionKey(event), pluginPanelToggleAgentId(event));
  const closes = event instanceof CustomEvent && event.detail?.open === false;
  const queue = slot === "link-reader" && !closes ? (pendingToggles.get(key) ?? []) : [];
  queue.push({ slot, event, createdAt: now });
  pendingToggles.set(key, queue);
}

/** Clear an intent that the active pane already handled directly. */
export function clearSessionPanelToggle(slot: SessionPanelToggleSlot, event: Event): void {
  const key = toggleKey(slot, panelToggleSessionKey(event), pluginPanelToggleAgentId(event));
  const queue = pendingToggles.get(key)?.filter((pending) => pending.event !== event);
  if (queue?.length) {
    pendingToggles.set(key, queue);
  } else {
    pendingToggles.delete(key);
  }
}

/** Claim an intent only after a mounted pane becomes its active owner. */
export function takeSessionPanelToggle(
  slot: SessionPanelToggleSlot,
  sessionKey?: string,
): Event | null {
  const targetKey = toggleKey(slot, sessionKey);
  const key = pendingToggles.has(targetKey) ? targetKey : toggleKey(slot);
  const queue =
    pendingToggles.get(key)?.filter((pending) => Date.now() - pending.createdAt <= INTENT_TTL_MS) ??
    [];
  const pending = queue.shift();
  if (queue.length) {
    pendingToggles.set(key, queue);
  } else {
    pendingToggles.delete(key);
  }
  return pending?.event ?? null;
}

/** Claim the next plugin-panel intent for a mounted conversation, never another session's. */
export function takePluginSessionPanelToggle(
  sessionKey: string,
  agentId: string,
): { slot: `plugin:${string}/${string}`; event: Event } | null {
  const now = Date.now();
  for (const [key, queue] of pendingToggles) {
    const pendingIndex = queue.findIndex(
      (pending) =>
        pending.slot.startsWith("plugin:") &&
        now - pending.createdAt <= INTENT_TTL_MS &&
        key === toggleKey(pending.slot, sessionKey, agentId),
    );
    if (pendingIndex < 0) {
      continue;
    }
    const [pending] = queue.splice(pendingIndex, 1);
    if (queue.length === 0) {
      pendingToggles.delete(key);
    }
    return { slot: pending!.slot as `plugin:${string}/${string}`, event: pending!.event };
  }
  return null;
}
