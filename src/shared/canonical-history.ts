import { createHash } from "node:crypto";
import { extractAssistantPhaseText, extractFirstTextBlock } from "./chat-message-content.js";

/** Host-owned, transient provenance. Never infer canonical identity from channel text. */
export type CanonicalHistorySource = {
  agentId: string;
  sessionId: string;
  entryId: string;
  fingerprint: string;
};

const sources = new WeakMap<object, { source: CanonicalHistorySource; snapshot: string }>();
type Projection = {
  text: string;
  render: (retained: (source: CanonicalHistorySource) => boolean) => string;
};
const projections = new WeakMap<object, Projection>();

/** Exact role/content/time equality deliberately keeps transformed messages as backfill. */
export function canonicalHistoryFingerprint(message: unknown): string | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    !("role" in message) ||
    (message.role !== "user" && message.role !== "assistant") ||
    !("content" in message) ||
    !("timestamp" in message)
  ) {
    return undefined;
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
      }),
    )
    .digest("hex");
}

export function attachCanonicalHistorySource(value: object, source: CanonicalHistorySource): void {
  sources.set(value, { source, snapshot: JSON.stringify(value) });
}

/** Bind a canonical reader's row to its exact source message and session. */
export function attachCanonicalTranscriptHistorySource(
  value: { id?: string; role: "user" | "assistant"; text: string },
  target: Pick<CanonicalHistorySource, "agentId" | "sessionId">,
  event: unknown,
): void {
  const message =
    event && typeof event === "object" && "message" in event ? event.message : undefined;
  if (
    !message ||
    typeof message !== "object" ||
    !("content" in message) ||
    !("role" in message) ||
    message.role !== value.role
  ) {
    return;
  }
  // Upstream text and display overrides can describe facts absent from native content.
  const nativeContent = {
    content: message.content,
    phase: "phase" in message ? message.phase : undefined,
  };
  const nativeText =
    value.role === "assistant"
      ? extractAssistantPhaseText(nativeContent)
      : extractFirstTextBlock(nativeContent)?.trim();
  if (value.text !== nativeText) {
    return;
  }
  const fingerprint = canonicalHistoryFingerprint(message);
  if (value.id && fingerprint) {
    attachCanonicalHistorySource(value, {
      agentId: target.agentId,
      sessionId: target.sessionId,
      entryId: value.id,
      fingerprint,
    });
  }
}

export function readCanonicalHistorySource(value: object): CanonicalHistorySource | undefined {
  const owned = sources.get(value);
  if (!owned) {
    return undefined;
  }
  try {
    return owned.snapshot === JSON.stringify(value) ? owned.source : undefined;
  } catch {
    // A later transformation may attach non-serializable state. Keep the complete history.
    return undefined;
  }
}

/** Project only the history window already selected by its native owner. */
export function omitRetainedCanonicalHistory<T extends object>(
  history: T[],
  retained: ((source: CanonicalHistorySource) => boolean) | undefined,
): T[] {
  return retained
    ? history.filter((entry) => {
        const source = readCanonicalHistorySource(entry);
        return !source || !retained(source);
      })
    : history;
}

/** A renderer belongs to this exact producer fragment, and is never serialized. */
export function attachCanonicalHistoryProjection(
  fragment: { text: string },
  render: Projection["render"],
): void {
  projections.set(fragment, { text: fragment.text, render });
}

export function projectCanonicalHistoryText(
  fragment: { text: string },
  retained: (source: CanonicalHistorySource) => boolean,
): string {
  const owned = projections.get(fragment);
  return owned?.text === fragment.text ? owned.render(retained) : fragment.text;
}

export function hasCanonicalHistoryProjection(fragment: object): boolean {
  return projections.has(fragment);
}
