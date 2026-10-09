import type {
  WorkboardAutomation,
  WorkboardCard,
  WorkboardCardSummary,
  WorkboardMetadata,
  WorkboardNotification,
} from "@openclaw/workboard-contract";

export type WorkboardListView = "full" | "summary";

export function readWorkboardListView(value: unknown): WorkboardListView {
  if (value === undefined || value === "full" || value === "summary") {
    return value ?? "full";
  }
  throw new Error('view must be "full" or "summary".');
}

// Same order the Control UI uses to pick the notification that explains a blocked card.
function latestRunNotification(
  notifications: readonly WorkboardNotification[],
  runId: string | undefined,
): WorkboardNotification | undefined {
  if (!runId) {
    return undefined;
  }
  return notifications
    .filter((entry) => entry.runId === runId)
    .toSorted((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return right.createdAt - left.createdAt;
      }
      if (left.sequence !== undefined && right.sequence !== undefined) {
        return right.sequence - left.sequence || right.id.localeCompare(left.id);
      }
      if (left.sequence !== undefined) {
        return 1;
      }
      if (right.sequence !== undefined) {
        return -1;
      }
      return right.id.localeCompare(left.id);
    })[0];
}

function summarizeAutomation(automation: WorkboardAutomation): WorkboardAutomation {
  const {
    summary: _summary,
    workspaceAccess: _workspaceAccess,
    launch: _launch,
    createdCardIds: _createdCardIds,
    ...rest
  } = automation;
  return rest;
}

/**
 * Projects a card onto what a board tile, its filters and its alerts read. The open card,
 * edits and full-text search need the full card from workboard.cards.get.
 */
export function summarizeWorkboardCard(card: WorkboardCard): WorkboardCard {
  const { notes, events, metadata, summary: _summary, ...rest } = card;
  const attempts = metadata?.attempts ?? [];
  const notifications = metadata?.notifications ?? [];
  const sessionKeys = new Set<string>();
  for (const entry of [...attempts, ...(events ?? [])]) {
    if (entry.sessionKey) {
      sessionKeys.add(entry.sessionKey);
    }
  }
  const summary: WorkboardCardSummary = {
    hasNotes: Boolean(notes),
    comments: metadata?.comments?.length ?? 0,
    attempts: attempts.length,
    failedAttempts: attempts.filter(
      (attempt) =>
        attempt.status === "failed" || attempt.status === "blocked" || attempt.status === "stopped",
    ).length,
    proof: metadata?.proof?.length ?? 0,
    workerLogs: metadata?.workerLogs?.length ?? 0,
    notifications: notifications.length,
    events: events?.length ?? 0,
    sessionKeys: [...sessionKeys],
  };
  if (!metadata) {
    return { ...rest, summary };
  }
  const {
    comments: _comments,
    attempts: _attempts,
    proof: _proof,
    workerLogs: _workerLogs,
    notifications: _notifications,
    automation,
    ...keptMetadata
  } = metadata;
  const notification = latestRunNotification(notifications, card.runId ?? card.execution?.runId);
  const summaryMetadata: WorkboardMetadata = {
    ...keptMetadata,
    ...(automation ? { automation: summarizeAutomation(automation) } : {}),
    ...(notification ? { notifications: [notification] } : {}),
  };
  return { ...rest, metadata: summaryMetadata, summary };
}

/**
 * Drops archived cards unless an included card still links to them, so dependency
 * badges keep resolving their parents.
 */
export function withoutUnreferencedArchivedCards(cards: readonly WorkboardCard[]): WorkboardCard[] {
  const referenced = new Set<string>();
  for (const card of cards) {
    if (card.metadata?.archivedAt) {
      continue;
    }
    for (const link of card.metadata?.links ?? []) {
      if (link.targetCardId) {
        referenced.add(link.targetCardId);
      }
    }
  }
  return cards.filter((card) => !card.metadata?.archivedAt || referenced.has(card.id));
}
