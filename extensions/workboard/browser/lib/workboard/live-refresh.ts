import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { normalizeWorkboardChange, workboardChangeCardIds } from "./change-payload.ts";
import {
  refreshWorkboard,
  refreshWorkboardCards,
  shouldDeferWorkboardLiveRefresh,
} from "./loading.ts";
import { getWorkboardRuntime, getWorkboardState, type WorkboardHost } from "./runtime.ts";

const WORKBOARD_LIVE_REFRESH_RETRY_MS = 1000;
// One write often lands as several changes (move, then comment, then notification).
const WORKBOARD_LIVE_REFRESH_DELAY_MS = 250;

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function clearRetry(host: WorkboardHost): void {
  const runtime = getWorkboardRuntime(host);
  if (runtime.liveRefreshRetryTimer) {
    clearTimeout(runtime.liveRefreshRetryTimer);
    delete runtime.liveRefreshRetryTimer;
  }
}

function scheduleRetry(host: WorkboardHost, generation: number): void {
  const runtime = getWorkboardRuntime(host);
  if (runtime.liveRefreshRetryTimer) {
    return;
  }
  runtime.liveRefreshRetryTimer = setTimeout(() => {
    delete runtime.liveRefreshRetryTimer;
    if ((runtime.liveRefreshGeneration ?? 0) === generation) {
      void runPendingRefresh(host);
    }
  }, WORKBOARD_LIVE_REFRESH_RETRY_MS);
}

async function runPendingRefresh(host: WorkboardHost): Promise<void> {
  const runtime = getWorkboardRuntime(host);
  if (runtime.liveRefreshPromise) {
    return await runtime.liveRefreshPromise;
  }
  const generation = runtime.liveRefreshGeneration ?? 0;
  const promise = (async () => {
    while (runtime.liveRefreshPending && (runtime.liveRefreshGeneration ?? 0) === generation) {
      const entry = runtime.liveRefreshEntry;
      const state = getWorkboardState(host);
      if (!entry?.client || documentHidden() || shouldDeferWorkboardLiveRefresh(state)) {
        return;
      }
      runtime.liveRefreshPending = false;
      const targetEpoch = runtime.liveChangeEpoch;
      const targetRevision = runtime.liveHighestSeenRevision ?? 0;
      const cardIds = runtime.liveFullRefreshPending ? [] : [...(runtime.livePendingCardIds ?? [])];
      delete runtime.livePendingCardIds;
      delete runtime.liveFullRefreshPending;
      const refreshed =
        (cardIds.length > 0 &&
          (await refreshWorkboardCards({
            host,
            client: entry.client,
            cardIds,
            requestUpdate: entry.requestUpdate,
          }))) ||
        (await refreshWorkboard({
          host,
          client: entry.client,
          requestUpdate: entry.requestUpdate,
          source: "live",
        }));
      if ((runtime.liveRefreshGeneration ?? 0) !== generation) {
        return;
      }
      if (!refreshed) {
        runtime.liveRefreshPending = true;
        runtime.liveFullRefreshPending = true;
        scheduleRetry(host, generation);
        return;
      }
      if (runtime.liveChangeEpoch === targetEpoch) {
        runtime.liveAppliedRevision = Math.max(runtime.liveAppliedRevision ?? 0, targetRevision);
      }
      runtime.liveRefreshPending =
        runtime.liveChangeEpoch !== targetEpoch ||
        (runtime.liveHighestSeenRevision ?? 0) > (runtime.liveAppliedRevision ?? 0);
    }
  })();
  runtime.liveRefreshPromise = promise;
  try {
    await promise;
  } finally {
    if (runtime.liveRefreshPromise === promise) {
      delete runtime.liveRefreshPromise;
    }
    const state = getWorkboardState(host);
    if (
      runtime.liveRefreshPending &&
      !runtime.liveRefreshRetryTimer &&
      runtime.liveRefreshEntry?.client &&
      !documentHidden() &&
      !shouldDeferWorkboardLiveRefresh(state)
    ) {
      void runPendingRefresh(host);
    }
  }
}

export function configureWorkboardLiveRefresh(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}): boolean {
  const runtime = getWorkboardRuntime(params.host);
  const requiresCanonicalReload = Boolean(
    params.client && runtime.liveRefreshEntry?.client !== params.client,
  );
  runtime.liveRefreshEntry = {
    client: params.client,
    requestUpdate: params.requestUpdate,
  };
  if (runtime.liveRefreshPending && !runtime.liveRefreshRetryTimer) {
    void runPendingRefresh(params.host);
  }
  return requiresCanonicalReload;
}

export function handleWorkboardChanged(host: WorkboardHost, payload: unknown): boolean {
  const change = normalizeWorkboardChange(payload);
  if (!change) {
    return false;
  }
  const runtime = getWorkboardRuntime(host);
  let contiguous = false;
  if (runtime.liveChangeEpoch !== change.epoch) {
    runtime.liveChangeEpoch = change.epoch;
    runtime.liveHighestSeenRevision = change.revision;
    runtime.liveAppliedRevision = 0;
  } else if (change.revision <= (runtime.liveHighestSeenRevision ?? 0)) {
    return false;
  } else {
    contiguous = change.revision === (runtime.liveHighestSeenRevision ?? 0) + 1;
    runtime.liveHighestSeenRevision = change.revision;
  }
  // A missed revision may have touched any card, so only a gapless named change stays narrow.
  const cardIds = contiguous ? workboardChangeCardIds(host, change) : undefined;
  if (cardIds && !runtime.liveFullRefreshPending) {
    const pending = (runtime.livePendingCardIds ??= new Set());
    for (const id of cardIds) {
      pending.add(id);
    }
  } else {
    runtime.liveFullRefreshPending = true;
    delete runtime.livePendingCardIds;
  }
  runtime.liveRefreshPending = true;
  clearRetry(host);
  if (!runtime.liveRefreshDelayTimer) {
    const generation = runtime.liveRefreshGeneration ?? 0;
    runtime.liveRefreshDelayTimer = setTimeout(() => {
      delete runtime.liveRefreshDelayTimer;
      if ((runtime.liveRefreshGeneration ?? 0) === generation) {
        void runPendingRefresh(host);
      }
    }, WORKBOARD_LIVE_REFRESH_DELAY_MS);
  }
  return true;
}

export { noteWorkboardCardsChanged } from "./change-payload.ts";

export function resumeWorkboardLiveRefresh(host: WorkboardHost): void {
  const runtime = getWorkboardRuntime(host);
  if (runtime.liveRefreshPending && !runtime.liveRefreshRetryTimer) {
    void runPendingRefresh(host);
  }
}
