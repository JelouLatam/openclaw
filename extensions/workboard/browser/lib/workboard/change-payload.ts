import type { WorkboardChange } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getWorkboardRuntime, type WorkboardHost } from "./runtime.ts";

export function normalizeWorkboardChange(payload: unknown): WorkboardChange | null {
  if (!isRecord(payload)) {
    return null;
  }
  const epoch = payload.epoch;
  const revision = payload.revision;
  const keys = Object.keys(payload);
  return keys.length === 2 &&
    keys.includes("epoch") &&
    keys.includes("revision") &&
    typeof epoch === "string" &&
    epoch.length > 0 &&
    epoch.length <= 128 &&
    typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision > 0
    ? { epoch, revision }
    : null;
}

const MAX_HINTED_CARD_IDS = 20;

/** Remembers the cards a change touched; the server sends this just before that change. */
export function noteWorkboardCardsChanged(host: WorkboardHost, payload: unknown): void {
  if (!isRecord(payload) || !Array.isArray(payload.cardIds)) {
    return;
  }
  const change = normalizeWorkboardChange({ epoch: payload.epoch, revision: payload.revision });
  const cardIds = payload.cardIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256,
  );
  if (
    change &&
    cardIds.length > 0 &&
    cardIds.length === payload.cardIds.length &&
    cardIds.length <= MAX_HINTED_CARD_IDS
  ) {
    getWorkboardRuntime(host).cardHint = { ...change, cardIds };
  }
}

export function workboardChangeCardIds(
  host: WorkboardHost,
  change: WorkboardChange,
): string[] | undefined {
  const hint = getWorkboardRuntime(host).cardHint;
  return hint?.epoch === change.epoch && hint.revision === change.revision
    ? hint.cardIds
    : undefined;
}
