import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { WorkboardChange } from "@openclaw/workboard-contract";
import type {
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardWriteAuthority,
} from "./persistence-types.js";

// Larger writes (bulk moves, dispatch) are cheaper to reload as one list than card by card.
const MAX_CHANGE_CARD_IDS = 20;

export class WorkboardStoreRuntime {
  private readonly operationScope = new AsyncLocalStorage<{ active: boolean }>();
  private readonly operations = new Set<Promise<unknown>>();
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private sealed = false;
  private readonly epoch = randomUUID();
  private revision = 0;
  private mutationRevision = 0;
  private externalDataVersion: number | undefined;
  // Undefined once a write since the last change touched something other than known cards.
  private changedCardIds: Set<string> | undefined = new Set();
  private readonly listeners = new Set<(change: WorkboardChange) => void>();
  private readonly initialization: Promise<void>;

  constructor(
    private readonly readDataVersion?: () => number | Promise<number>,
    private readonly closePersistence?: () => void | Promise<void>,
    ready?: Promise<number>,
    private readonly runWithWriteAuthority?: WorkboardWriteAuthority,
  ) {
    this.initialization = Promise.resolve(ready ?? readDataVersion?.()).then((version) => {
      this.externalDataVersion = version;
    });
    void this.initialization.catch(() => {});
  }

  ready(): Promise<void> {
    return this.runOperation(() => undefined);
  }

  async runOperation<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.sealed && !this.operationScope.getStore()?.active) {
      throw new Error("workboard store is closed.");
    }
    const context = { active: true };
    const operation = this.operationScope.run(context, async () => {
      await this.initialization;
      return await run();
    });
    this.operations.add(operation);
    try {
      return await operation;
    } finally {
      // Detached callbacks must not reuse admission after this operation settles.
      context.active = false;
      this.operations.delete(operation);
    }
  }

  close(): Promise<void> {
    this.sealed = true;
    this.closePromise ??= Promise.resolve()
      .then(async () => {
        // Admitted operations can still add nested work. Callers own failures;
        // join the entire set before closing this generation's connection.
        while (this.operations.size > 0) {
          await Promise.allSettled(this.operations);
        }
        this.operationScope.disable();
        await this.closePersistence?.();
      })
      .catch((error: unknown) => {
        this.closePromise = undefined;
        throw error;
      });
    return this.closePromise;
  }

  protected track<T>(
    store: WorkboardKeyedStore<T>,
    { notifyChanges = true, cards = false }: { notifyChanges?: boolean; cards?: boolean } = {},
  ): WorkboardKeyedStore<T> {
    const cardId = (key: string) => (cards ? key : undefined);
    return {
      register: (key, value) =>
        this.trackMutation(
          () => store.register(key, value),
          () => notifyChanges,
          cardId(key),
        ),
      lookup: (key) => this.runOperation(() => store.lookup(key)),
      delete: (key) =>
        this.trackMutation(
          () => store.delete(key),
          (deleted) => deleted && notifyChanges,
          cardId(key),
        ),
      entries: () => this.runOperation(() => store.entries()),
    };
  }

  protected trackCardStore(store: WorkboardCardStore): WorkboardCardStore {
    return {
      ...this.track(store, { cards: true }),
      entries: (scope) => this.runOperation(() => store.entries(scope)),
      registerIfAbsent: (key, value) =>
        this.trackMutation(() => store.registerIfAbsent(key, value), Boolean, key),
      registerIfUpdatedAt: (key, value, expectedUpdatedAt) =>
        this.trackMutation(
          () => store.registerIfUpdatedAt(key, value, expectedUpdatedAt),
          Boolean,
          key,
        ),
      deleteIfUpdatedAt: (key, expectedUpdatedAt) =>
        this.trackMutation(() => store.deleteIfUpdatedAt(key, expectedUpdatedAt), Boolean, key),
      claimIfOwnerAvailable: (key, value, expectedUpdatedAt, ownerId, now) =>
        this.trackMutation(
          () => store.claimIfOwnerAvailable(key, value, expectedUpdatedAt, ownerId, now),
          (result) => result === "updated",
          key,
        ),
      listCardStatuses: (ids) => this.runOperation(() => store.listCardStatuses(ids)),
      listBoardAggregates: () => this.runOperation(() => store.listBoardAggregates()),
      listStatsAggregates: (boardId) => this.runOperation(() => store.listStatsAggregates(boardId)),
      hasCards: (boardId) => this.runOperation(() => store.hasCards(boardId)),
    };
  }

  private trackMutation<T>(
    run: () => Promise<T>,
    changed: (result: T) => boolean = Boolean,
    cardId?: string,
  ): Promise<T> {
    return this.runOperation(async () => {
      const result = await run();
      if (changed(result)) {
        this.mutationRevision += 1;
        if (cardId === undefined) {
          this.changedCardIds = undefined;
        } else {
          this.changedCardIds?.add(cardId);
        }
      }
      return result;
    });
  }

  subscribeChanges(listener: (change: WorkboardChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  announceChangeEpoch(): void {
    this.changedCardIds = undefined;
    this.emit();
  }

  /**
   * Opaque token that differs after any committed card or board write, in-process or from
   * another connection; equal tokens mean a read would return the same rows.
   */
  async readCursor(): Promise<string> {
    await this.reconcileExternalChanges();
    return `${this.epoch}:${this.revision}:${this.mutationRevision}`;
  }

  reconcileExternalChanges(): Promise<boolean> {
    return this.runOperation(async () => {
      if (!this.readDataVersion) {
        return false;
      }
      const current = await this.readDataVersion();
      if (current === this.externalDataVersion) {
        return false;
      }
      this.externalDataVersion = current;
      this.changedCardIds = undefined;
      this.emit();
      return true;
    });
  }

  protected async enqueueMutation<T>(
    run: () => Promise<T>,
    assertCurrent?: () => void,
  ): Promise<T> {
    return await this.runOperation(async () => {
      const runAndNotify = async () =>
        await this.withMutationAuthority(async () => await this.runMutation(run), assertCurrent);
      const result = this.mutationQueue.then(runAndNotify, runAndNotify);
      this.mutationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    });
  }

  protected async withMutationAuthority<T>(
    run: () => Promise<T>,
    assertCurrent?: () => void,
  ): Promise<T> {
    if (!assertCurrent) {
      return await run();
    }
    if (!this.runWithWriteAuthority) {
      throw new Error("Workboard persistence does not support current-owner admission.");
    }
    return await this.runWithWriteAuthority(assertCurrent, run);
  }

  private async runMutation<T>(run: () => Promise<T>): Promise<T> {
    const initialRevision = this.mutationRevision;
    try {
      return await run();
    } finally {
      if (this.mutationRevision !== initialRevision) {
        this.emit();
      }
    }
  }

  private emit(): void {
    const cardIds = this.changedCardIds;
    this.changedCardIds = new Set();
    const change: WorkboardChange = {
      epoch: this.epoch,
      revision: ++this.revision,
      ...(cardIds?.size && cardIds.size <= MAX_CHANGE_CARD_IDS ? { cardIds: [...cardIds] } : {}),
    };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // Persistence already succeeded. Observers cannot turn it into a reported failure.
      }
    }
  }
}
