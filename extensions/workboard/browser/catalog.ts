import type { GatewayBrowserClient } from "./api/gateway.ts";
import type { WorkboardCapability } from "./lib/workboard/capability.ts";
import {
  normalizeWorkboardChange,
  noteWorkboardCardsChanged,
  workboardChangeCardIds,
} from "./lib/workboard/change-payload.ts";
import { loadWorkboardCatalog, refreshWorkboardCards } from "./lib/workboard/loading.ts";
import { normalizeCardsPayload } from "./lib/workboard/normalization.ts";
import {
  getWorkboardRuntime,
  getWorkboardState,
  invalidateWorkboardLoads,
} from "./lib/workboard/runtime.ts";
import {
  WORKBOARD_CARDS_CHANGED_EVENT,
  WORKBOARD_CHANGED_EVENT,
  type WorkboardBoardSummary,
  type WorkboardChange,
} from "./lib/workboard/types.ts";

type WorkboardCatalogSnapshot = {
  boards: readonly Pick<WorkboardBoardSummary, "id" | "name" | "icon" | "color">[];
  ready: boolean;
};
type WorkboardCatalogRuntime = {
  sync(client: GatewayBrowserClient | null, connected: boolean): void;
  handleGatewayEvent(event: string, payload?: unknown): void;
  dispose(): void;
};

const RETRY_MS = 2_000;
const CHANGE_DELAY_MS = 1_000;

export type WorkboardCatalogOptions = { changeDelayMs?: number };

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

type CatalogLoad = { client: GatewayBrowserClient; promise: Promise<boolean> };

class WorkboardCatalog implements WorkboardCatalogRuntime {
  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private disposed = false;
  private generation = 0;
  private connectionGeneration = 0;
  private load: CatalogLoad | null = null;
  private retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private changeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private changePending = false;
  private lastChange: WorkboardChange | undefined;
  private pendingCardIds = new Set<string>();
  private fullReloadPending = false;
  private snapshot: WorkboardCatalogSnapshot = { boards: [], ready: false };
  private readonly changeDelayMs: number;
  private readonly onVisibilityChange = () => {
    if (!documentHidden()) {
      this.scheduleChange();
    }
  };

  constructor(
    private readonly onSnapshot: (snapshot: WorkboardCatalogSnapshot) => void,
    private readonly host: WorkboardCapability,
    options: WorkboardCatalogOptions = {},
  ) {
    this.changeDelayMs = options.changeDelayMs ?? CHANGE_DELAY_MS;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  sync(client: GatewayBrowserClient | null, connected: boolean): void {
    if (this.disposed) {
      return;
    }
    const reconnecting = connected && !this.connected && this.snapshot.ready;
    if (this.connected !== connected || this.client !== client) {
      this.connectionGeneration += 1;
      this.lastChange = undefined;
    }
    this.connected = connected;
    if (!connected || !client) {
      if (this.load) {
        // Preserve the cached catalog, but prevent an old request from publishing
        // after disconnect or blocking a fresh load on a fast reconnect.
        this.generation += 1;
        this.load = null;
        invalidateWorkboardLoads(this.host);
      }
      this.clearRetry();
      this.clearChange();
      return;
    }
    if (this.client !== client) {
      this.client = client;
      this.generation += 1;
      this.load = null;
      invalidateWorkboardLoads(this.host);
      this.host.clearCatalog();
      this.publishCatalog([], false);
    }
    this.ensureAndRecover(reconnecting);
  }

  handleGatewayEvent(event: string, payload?: unknown): void {
    if (event === WORKBOARD_CARDS_CHANGED_EVENT) {
      noteWorkboardCardsChanged(this.host, payload);
      return;
    }
    if (event === WORKBOARD_CHANGED_EVENT && this.connected && this.client) {
      this.noteChange(payload);
      this.changePending = true;
      this.scheduleChange();
    }
  }

  private noteChange(payload: unknown): void {
    const change = normalizeWorkboardChange(payload);
    const previous = this.lastChange;
    if (change && (previous?.epoch !== change.epoch || change.revision > previous.revision)) {
      this.lastChange = change;
    }
    const cardIds =
      change && previous?.epoch === change.epoch && change.revision === previous.revision + 1
        ? workboardChangeCardIds(this.host, change)
        : undefined;
    if (cardIds && !this.fullReloadPending) {
      for (const id of cardIds) {
        this.pendingCardIds.add(id);
      }
    } else {
      this.fullReloadPending = true;
      this.pendingCardIds.clear();
    }
  }

  private async read(client: GatewayBrowserClient): Promise<boolean> {
    const named =
      this.snapshot.ready && !this.fullReloadPending && this.pendingCardIds.size > 0
        ? [...this.pendingCardIds]
        : undefined;
    this.pendingCardIds.clear();
    this.fullReloadPending = false;
    // An open Workboard page keeps the shared cards current itself.
    if (this.snapshot.ready && getWorkboardRuntime(this.host).liveRefreshEntry?.client) {
      if (named) {
        return true;
      }
      const payload = await client.request("workboard.boards.list", {});
      getWorkboardState(this.host).boards = normalizeCardsPayload(payload).boards;
      return true;
    }
    if (
      named &&
      (await refreshWorkboardCards({
        host: this.host,
        client,
        cardIds: named,
        requestUpdate: this.host.notify,
      }))
    ) {
      return true;
    }
    return await loadWorkboardCatalog({
      host: this.host,
      client,
      requestUpdate: this.host.notify,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.connectionGeneration += 1;
    this.generation += 1;
    this.load = null;
    this.clearRetry();
    this.clearChange();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    invalidateWorkboardLoads(this.host);
    this.host.clearCatalog();
  }

  private scheduleChange(): void {
    if (
      this.disposed ||
      !this.changePending ||
      this.changeTimer !== null ||
      documentHidden() ||
      !this.connected ||
      !this.client
    ) {
      return;
    }
    this.changePending = false;
    this.ensureAndRecover(true);
    this.changeTimer = globalThis.setTimeout(() => {
      this.changeTimer = null;
      this.scheduleChange();
    }, this.changeDelayMs);
  }

  private clearChange(): void {
    this.changePending = false;
    if (this.changeTimer !== null) {
      globalThis.clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
  }

  private ensureAndRecover(force: boolean): void {
    const client = this.client;
    if (!client || !this.connected) {
      return;
    }
    const connectionGeneration = this.connectionGeneration;
    void this.ensure(client, force).then((loaded) => {
      if (
        this.disposed ||
        !this.connected ||
        this.client !== client ||
        connectionGeneration !== this.connectionGeneration
      ) {
        return;
      }
      if (loaded) {
        this.clearRetry();
        return;
      }
      if (!force && this.snapshot.ready) {
        return;
      }
      if (this.retryTimer === null) {
        this.retryTimer = globalThis.setTimeout(() => {
          this.retryTimer = null;
          this.ensureAndRecover(true);
        }, RETRY_MS);
      }
    });
  }

  private async ensure(client: GatewayBrowserClient, force: boolean): Promise<boolean> {
    if (this.disposed || !this.connected || this.client !== client) {
      return false;
    }
    if (!force && this.snapshot.ready) {
      return false;
    }
    const currentLoad = this.load;
    if (currentLoad?.client === client) {
      const loaded = await currentLoad.promise;
      if (this.disposed || !this.connected || this.client !== client) {
        return false;
      }
      if (!force) {
        return loaded;
      }
      if (this.load && this.load !== currentLoad) {
        return await this.load.promise;
      }
      if (this.load === currentLoad) {
        this.load = null;
      }
      return await this.ensure(client, true);
    }
    const generation = ++this.generation;
    const pending = (async () => {
      try {
        const loaded = await this.read(client);
        if (
          !loaded ||
          this.disposed ||
          !this.connected ||
          this.client !== client ||
          generation !== this.generation
        ) {
          return false;
        }
        this.publishCatalog(getWorkboardState(this.host).boards, true);
        return true;
      } catch {
        return false;
      }
    })();
    const load = { client, promise: pending };
    this.load = load;
    try {
      return await pending;
    } finally {
      if (this.load === load) {
        this.load = null;
      }
    }
  }

  private publishCatalog(boards: WorkboardBoardSummary[], ready: boolean): void {
    this.host.setBoardsReady(ready);
    this.host.notify();
    const snapshot: WorkboardCatalogSnapshot = {
      boards: boards.map(({ id, name, icon, color }) => ({
        id,
        ...(name ? { name } : {}),
        ...(icon ? { icon } : {}),
        ...(color ? { color } : {}),
      })),
      ready,
    };
    this.snapshot = snapshot;
    this.onSnapshot(snapshot);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      globalThis.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

export function createWorkboardCatalogRuntime(
  onSnapshot: (snapshot: WorkboardCatalogSnapshot) => void,
  host: WorkboardCapability,
  options?: WorkboardCatalogOptions,
): WorkboardCatalogRuntime {
  return new WorkboardCatalog(onSnapshot, host, options);
}
