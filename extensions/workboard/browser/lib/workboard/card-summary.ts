import type { WorkboardCard, WorkboardCardSummary } from "./types.ts";

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function normalizeCardSummary(value: unknown): WorkboardCardSummary | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const summary = value as Record<string, unknown>;
  return {
    hasNotes: summary.hasNotes === true,
    comments: count(summary.comments),
    attempts: count(summary.attempts),
    failedAttempts: count(summary.failedAttempts),
    proof: count(summary.proof),
    workerLogs: count(summary.workerLogs),
    notifications: count(summary.notifications),
    events: count(summary.events),
    sessionKeys: Array.isArray(summary.sessionKeys)
      ? summary.sessionKeys.filter((key): key is string => typeof key === "string")
      : [],
  };
}

/** A summary card lacks notes, events and history records; open or edit only full cards. */
export function isWorkboardSummaryCard(card: WorkboardCard): boolean {
  return card.summary !== undefined;
}

export function workboardCardCommentCount(card: WorkboardCard): number {
  return card.summary?.comments ?? card.metadata?.comments?.length ?? 0;
}

export function workboardCardProofCount(card: WorkboardCard): number {
  return card.summary?.proof ?? card.metadata?.proof?.length ?? 0;
}

export function workboardCardAttemptCount(card: WorkboardCard): number {
  return card.summary?.attempts ?? card.metadata?.attempts?.length ?? 0;
}

export function workboardCardFailedAttemptCount(card: WorkboardCard): number {
  if (card.summary) {
    return card.summary.failedAttempts;
  }
  return (
    card.metadata?.attempts?.filter(
      (attempt) =>
        attempt.status === "failed" || attempt.status === "blocked" || attempt.status === "stopped",
    ).length ?? 0
  );
}
