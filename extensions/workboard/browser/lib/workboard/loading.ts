import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { replaceCard, setWorkboardCards } from "./card-state.ts";
import { isWorkboardSummaryCard } from "./card-summary.ts";
import { formatError } from "./normalization-utils.ts";
import { normalizeCardPayload, normalizeCardsPayload } from "./normalization.ts";
import {
  getWorkboardRuntime,
  getWorkboardState,
  isCurrentWorkboardLoadGeneration,
  nextWorkboardLoadGeneration,
  workboardHasActiveWrites,
  type WorkboardHost,
  type WorkboardLoadToken,
} from "./runtime.ts";
import type { WorkboardCard, WorkboardRefreshSource, WorkboardUiState } from "./types.ts";

const CATALOG_LIST_PARAMS = { view: "summary" };

export function workboardListParams(state: WorkboardUiState): Record<string, unknown> {
  // Search matches notes, comments and logs, which summaries leave out.
  if (state.query.trim()) {
    return {};
  }
  return state.showArchived ? { view: "summary", includeArchived: true } : CATALOG_LIST_PARAMS;
}

/** True when the cards in state came from a different list view than the page needs now. */
export function workboardListViewChanged(host: WorkboardHost): boolean {
  const runtime = getWorkboardRuntime(host);
  const state = getWorkboardState(host);
  return (
    state.loaded &&
    !runtime.loadPromise &&
    runtime.listViewKey !== JSON.stringify(workboardListParams(state))
  );
}

function focusedCardIds(state: WorkboardUiState): Set<string> {
  return new Set(
    [state.detailCardId, state.editingCardId].filter((id): id is string => Boolean(id)),
  );
}

function readCardResult(payload: unknown): WorkboardCard | null {
  return isRecord(payload) && payload.card === null ? null : normalizeCardPayload(payload);
}

function applyFetchedCard(state: WorkboardUiState, id: string, card: WorkboardCard | null) {
  const existing = state.cards.find((entry) => entry.id === id);
  if (!card) {
    if (existing) {
      setWorkboardCards(
        state,
        state.cards.filter((entry) => entry.id !== id),
      );
    }
    return;
  }
  // A read that started before a write can land after the write's own response.
  if (
    existing &&
    (card.updatedAt < existing.updatedAt ||
      (card.updatedAt === existing.updatedAt &&
        isWorkboardSummaryCard(card) &&
        !isWorkboardSummaryCard(existing)))
  ) {
    return;
  }
  replaceCard(state, card);
}

export function applyListedCards(
  params: Pick<LoadWorkboardParams, "host" | "client" | "requestUpdate">,
  cards: WorkboardCard[],
  listParams: Record<string, unknown>,
) {
  const state = getWorkboardState(params.host);
  const runtime = getWorkboardRuntime(params.host);
  const focused = focusedCardIds(state);
  const stale: string[] = [];
  const merged = cards.map((card) => {
    const existing = focused.has(card.id)
      ? state.cards.find((entry) => entry.id === card.id)
      : undefined;
    if (!existing || !isWorkboardSummaryCard(card) || isWorkboardSummaryCard(existing)) {
      return card;
    }
    // Keep the open card's detail on screen while its fresh copy loads.
    if (card.updatedAt !== existing.updatedAt) {
      stale.push(card.id);
    }
    return existing;
  });
  setWorkboardCards(state, merged);
  runtime.listViewKey = JSON.stringify(listParams);
  runtime.detailFailures?.clear();
  if (params.client) {
    for (const id of stale) {
      void loadWorkboardCardDetail({ ...params, client: params.client, cardId: id, force: true });
    }
  }
}

/** Replaces a summary or outdated card with its full copy; concurrent calls share one read. */
export function loadWorkboardCardDetail(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient;
  cardId: string;
  requestUpdate?: () => void;
  force?: boolean;
}): Promise<void> {
  const runtime = getWorkboardRuntime(params.host);
  const loads = (runtime.detailLoads ??= new Map());
  const current = loads.get(params.cardId);
  if (current) {
    // A forced read must start after the change that made the card stale.
    return params.force
      ? current.then(() => loadWorkboardCardDetail({ ...params, force: false }))
      : current;
  }
  if (!params.force && runtime.detailFailures?.has(params.cardId)) {
    return Promise.resolve();
  }
  const load = (async () => {
    try {
      const payload = await params.client.request("workboard.cards.get", { id: params.cardId });
      applyFetchedCard(getWorkboardState(params.host), params.cardId, readCardResult(payload));
      runtime.detailFailures?.delete(params.cardId);
    } catch {
      (runtime.detailFailures ??= new Set()).add(params.cardId);
    } finally {
      loads.delete(params.cardId);
      params.requestUpdate?.();
    }
  })();
  loads.set(params.cardId, load);
  return load;
}

/** Re-reads only the named cards; false means the caller should reload the list instead. */
export async function refreshWorkboardCards(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient;
  cardIds: readonly string[];
  requestUpdate?: () => void;
}): Promise<boolean> {
  const state = getWorkboardState(params.host);
  if (state.dispatching || workboardHasActiveWrites(state)) {
    return false;
  }
  const focused = focusedCardIds(state);
  try {
    const cards = await Promise.all(
      params.cardIds.map(async (id) =>
        readCardResult(
          await params.client.request(
            "workboard.cards.get",
            focused.has(id) ? { id } : { id, view: "summary" },
          ),
        ),
      ),
    );
    params.cardIds.forEach((id, index) => applyFetchedCard(state, id, cards[index] ?? null));
    state.lastRefreshAt = Date.now();
    return true;
  } catch {
    return false;
  } finally {
    params.requestUpdate?.();
  }
}

type LoadWorkboardParams = {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  force?: boolean;
  refreshDiagnostics?: boolean;
  preserveError?: boolean;
};

export async function loadWorkboard(params: LoadWorkboardParams): Promise<boolean> {
  return await loadWorkboardInternal(params);
}

export async function loadWorkboardCatalog(
  params: Pick<LoadWorkboardParams, "host" | "client" | "requestUpdate">,
): Promise<boolean> {
  return await loadWorkboardInternal({ ...params, force: true }, undefined, true);
}

async function loadWorkboardInternal(
  params: LoadWorkboardParams,
  queuedAfterGeneration?: number,
  catalogOnly = false,
): Promise<boolean> {
  const runtime = getWorkboardRuntime(params.host);
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    state.dispatching ||
    workboardHasActiveWrites(state) ||
    (!params.force && (state.loaded || state.loadAttempted))
  ) {
    return false;
  }
  const client = params.client;
  const existingLoad = runtime.loadPromise;
  if (existingLoad) {
    const existingGeneration = runtime.loadGeneration;
    const requiresTaskLoad = !catalogOnly && runtime.loadToken?.catalogOnly;
    const result = await existingLoad;
    const existingLoadIsCurrent =
      existingGeneration !== undefined &&
      isCurrentWorkboardLoadGeneration(params.host, existingGeneration);
    const currentLoadMarker = runtime.loadToken;
    // Only follow a replacement created by this load's forced-waiter queue.
    // Fresh loads after teardown or writes must not revive stale callers.
    const queuedLoadReplacedExisting =
      existingGeneration !== undefined &&
      currentLoadMarker?.queuedAfterGeneration === existingGeneration &&
      Boolean(runtime.loadPromise);
    // Forced callers carry their own diagnostics/task-refresh contract, so a
    // weaker in-flight load cannot satisfy them.
    return (params.force || requiresTaskLoad) &&
      (existingLoadIsCurrent || queuedLoadReplacedExisting) &&
      !state.dispatching &&
      !workboardHasActiveWrites(state)
      ? await loadWorkboardInternal(params, existingGeneration, catalogOnly)
      : result;
  }
  const generation = nextWorkboardLoadGeneration(params.host);
  const loadToken: WorkboardLoadToken = { queuedAfterGeneration, catalogOnly };
  runtime.loadToken = loadToken;
  if (!catalogOnly) {
    state.loadAttempted = true;
    state.loading = true;
    if (!params.preserveError) {
      delete runtime.loadError;
      state.error = null;
    }
    state.lastRefreshError = null;
    params.requestUpdate?.();
  }
  const loadPromise = (async () => {
    try {
      if (params.refreshDiagnostics) {
        try {
          await client.request("workboard.cards.diagnostics.refresh", {});
        } catch (error) {
          if (isCurrentWorkboardLoadGeneration(params.host, generation)) {
            state.lastRefreshError = formatError(error);
          }
        }
      }
      const listParams = catalogOnly ? CATALOG_LIST_PARAMS : workboardListParams(state);
      const payload = await client.request("workboard.cards.list", listParams);
      if (
        catalogOnly &&
        (!isRecord(payload) || !Array.isArray(payload.cards) || !Array.isArray(payload.boards))
      ) {
        return false;
      }
      const normalized = normalizeCardsPayload(payload);
      if (!isCurrentWorkboardLoadGeneration(params.host, generation)) {
        return false;
      }
      if (catalogOnly) {
        state.boards = normalized.boards;
        // Keep navigation current without replacing cards beneath an unfinished draft.
        if (shouldDeferWorkboardLiveRefresh(state)) {
          return true;
        }
        // Catalog hydration never establishes task freshness or authorizes stale edits.
        applyListedCards(params, normalized.cards, listParams);
        state.statuses = normalized.statuses;
        return true;
      }
      if (params.preserveError && shouldDeferWorkboardLiveRefresh(state)) {
        return false;
      }
      applyListedCards(params, normalized.cards, listParams);
      state.boards = normalized.boards;
      state.statuses = normalized.statuses;
      const recoveredLoadError = runtime.loadError;
      if (recoveredLoadError !== undefined && state.error === recoveredLoadError) {
        state.error = null;
      }
      delete runtime.loadError;
      // Preserve stale edit text for recovery, but never re-enable its full-card
      // save payload after canonical state may have changed.
      state.mutationReadiness = state.editingCardId ? "stale_edit_draft" : "ready";
      state.loaded = true;
      return true;
    } catch (error) {
      if (!catalogOnly && isCurrentWorkboardLoadGeneration(params.host, generation)) {
        const formattedError = formatError(error);
        if (params.preserveError) {
          state.lastRefreshError = formattedError;
        } else {
          runtime.loadError = formattedError;
          state.error = formattedError;
        }
      }
      return false;
    } finally {
      const isCurrentGeneration = isCurrentWorkboardLoadGeneration(params.host, generation);
      const ownsLoad = runtime.loadToken === loadToken;
      if (!catalogOnly && !isCurrentGeneration && !state.loaded) {
        state.loadAttempted = false;
      }
      if (!catalogOnly && (isCurrentGeneration || (ownsLoad && !state.draftSaving))) {
        state.loading = false;
      }
      if (ownsLoad) {
        delete runtime.loadPromise;
        delete runtime.loadToken;
      }
      params.requestUpdate?.();
    }
  })();
  runtime.loadPromise = loadPromise;
  return await loadPromise;
}

export async function refreshWorkboard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  source: WorkboardRefreshSource;
  refreshDiagnostics?: boolean;
}): Promise<boolean> {
  const state = getWorkboardState(params.host);
  const passive = params.source === "live";
  if (state.dispatching || workboardHasActiveWrites(state)) {
    return false;
  }
  const startedAt = Date.now();
  state.lastRefreshStartedAt = startedAt;
  state.lastRefreshSource = params.source;
  state.lastRefreshError = null;
  params.requestUpdate?.();
  if (!params.client) {
    state.lastRefreshError = "Gateway client unavailable";
    params.requestUpdate?.();
    return false;
  }
  const refreshed = await loadWorkboard({
    host: params.host,
    client: params.client,
    requestUpdate: params.requestUpdate,
    force: true,
    refreshDiagnostics: params.refreshDiagnostics,
    preserveError: passive,
  });
  state.lastRefreshSource = params.source;
  if (!passive && state.error) {
    state.lastRefreshError = state.error;
  } else if (refreshed) {
    state.lastRefreshAt = Date.now();
  }
  params.requestUpdate?.();
  return refreshed;
}

export function shouldDeferWorkboardLiveRefresh(state: WorkboardUiState): boolean {
  return Boolean(
    state.draftOpen ||
    state.editingCardId ||
    workboardHasActiveWrites(state) ||
    state.draggedCardId ||
    state.dispatching ||
    state.detailCommentBody.trim() ||
    state.draftCommentBody.trim(),
  );
}
