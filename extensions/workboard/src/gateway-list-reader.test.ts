// Workboard tests cover the shared gateway list read.
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { redactClaimToken } from "./card-redaction.js";
import { createWorkboardListReader } from "./gateway-helpers.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);

describe("workboard gateway list reader", () => {
  it("serves concurrent identical reads from one store read and refreshes after a write", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const first = await store.create({ title: "First" });
    const list = vi.spyOn(store, "list");
    const read = createWorkboardListReader(store, redactClaimToken);

    const results = await Promise.all(Array.from({ length: 10 }, () => read(undefined)));
    expect(list).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(results[0]?.cards.map((card) => card.id)).toEqual([first.id]);
    await read(undefined);
    expect(list).toHaveBeenCalledTimes(1);

    // create() lists cards itself to place the new one; count only the reader's reads.
    const second = await store.create({ title: "Second" });
    list.mockClear();
    const fresh = await read(undefined);
    expect(list).toHaveBeenCalledTimes(1);
    expect(fresh.cards.map((card) => card.id)).toEqual([first.id, second.id]);
    expect(fresh.boards.find((board) => board.id === "default")?.total).toBe(2);

    await store.addComment(first.id, { body: "noted" });
    list.mockClear();
    expect((await read(undefined)).cards[0]?.metadata?.comments).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(1);
    await read(undefined);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps one entry per normalized board and still rejects invalid board ids", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    await store.upsertBoard({ id: "planning" });
    await store.create({ title: "Planned", boardId: "planning" });
    await store.create({ title: "Default" });
    const list = vi.spyOn(store, "list");
    const read = createWorkboardListReader(store, redactClaimToken);

    const [all, planning, planningAgain] = await Promise.all([
      read(undefined),
      read("planning"),
      read(" Planning "),
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(all.cards).toHaveLength(2);
    expect(planning.cards.map((card) => card.title)).toEqual(["Planned"]);
    expect(planningAgain).toBe(planning);
    await expect(read("not valid!")).rejects.toThrow(/board id/);
  });

  it("sees a write from another connection before the external change poll runs", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    await store.create({ title: "Local" });
    const read = createWorkboardListReader(store, redactClaimToken);
    expect((await read(undefined)).cards).toHaveLength(1);

    const other = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    const otherStore = new WorkboardStore(other.cards, other);
    try {
      await otherStore.create({ title: "External" });
    } finally {
      await otherStore.close();
    }
    expect((await read(undefined)).cards.map((card) => card.title)).toEqual(["Local", "External"]);
  });

  it("does not cache a failed read", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    await store.create({ title: "Only" });
    const list = vi.spyOn(store, "list").mockRejectedValueOnce(new Error("sqlite busy"));
    const read = createWorkboardListReader(store, redactClaimToken);

    await expect(read(undefined)).rejects.toThrow("sqlite busy");
    expect((await read(undefined)).cards).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("redacts claim tokens in the shared result", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Claimed" });
    await store.claim(card.id, { ownerId: "worker-1" });
    const read = createWorkboardListReader(store, redactClaimToken);
    expect((await read(undefined)).cards[0]?.metadata?.claim?.token).toBe("[redacted]");
  });
});
