// Workboard tests cover summary list reads, single card reads and named change events.
import type { WorkboardChange } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { redactClaimToken } from "./card-redaction.js";
import { listWorkboardCards } from "./gateway-helpers.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

function captureMethods() {
  const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
  const api = {
    runtime: { state: { openKeyedStore: vi.fn() } },
    registerGatewayMethod: vi.fn((method: string, handler) => {
      methods.set(method, handler);
    }),
  } as unknown as OpenClawPluginApi;
  const call = async (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn();
    await methods.get(method)?.({ params, respond } as never);
    const [ok, result, error] = respond.mock.calls[0] ?? [];
    if (!ok) {
      throw new Error(error?.message ?? "no response");
    }
    return result;
  };
  return { api, call };
}

async function seedBoard() {
  const store = createWorkboardSqliteTestStore();
  const parent = await store.create({ title: "Archived parent" });
  const card = await store.create({ title: "Busy card", notes: "Long investigation notes" });
  await store.linkCards(parent.id, card.id);
  await store.addComment(card.id, { body: "First comment" });
  await store.addComment(card.id, { body: "Second comment" });
  await store.addProof(card.id, { status: "passed", command: "pnpm test" });
  const busy = await store.addWorkerLog(card.id, { message: "worker said hello" });
  const archivedParent = await store.archive(parent.id, true);
  const gone = await store.create({ title: "Archived alone" });
  await store.archive(gone.id, true);
  return { store, busy, archivedParent, goneId: gone.id };
}

describe("workboard summary reads", () => {
  it("keeps the default list unchanged and lists light active cards on request", async () => {
    const { store, busy, archivedParent, goneId } = await seedBoard();
    const { api, call } = captureMethods();
    registerWorkboardGatewayMethods({ api, store });

    const full = await call("workboard.cards.list", {});
    expect(full).toEqual(await listWorkboardCards(store, undefined, redactClaimToken));

    const light = await call("workboard.cards.list", { view: "summary" });
    expect(light.boards).toEqual(full.boards);
    expect(light.cards.map((card: { id: string }) => card.id)).toEqual([
      archivedParent.id,
      busy.id,
    ]);
    const summary = light.cards.find((card: { id: string }) => card.id === busy.id);
    expect(summary).not.toHaveProperty("notes");
    expect(summary).not.toHaveProperty("events");
    expect(summary.metadata).not.toHaveProperty("comments");
    expect(summary.metadata).not.toHaveProperty("proof");
    expect(summary.metadata).not.toHaveProperty("workerLogs");
    expect(summary.metadata.links).toEqual(busy.metadata?.links);
    expect(summary.summary).toEqual({
      hasNotes: true,
      comments: 2,
      attempts: 0,
      failedAttempts: 0,
      proof: 1,
      workerLogs: 1,
      notifications: 0,
      events: busy.events?.length,
      sessionKeys: [],
    });
    expect(JSON.stringify(light).length).toBeLessThan(JSON.stringify(full).length);

    const withArchived = await call("workboard.cards.list", {
      view: "summary",
      includeArchived: true,
    });
    expect(withArchived.cards.map((card: { id: string }) => card.id)).toContain(goneId);
    await expect(call("workboard.cards.list", { view: "everything" })).rejects.toThrow(
      'view must be "full" or "summary".',
    );
  });

  it("reads one card in full or as a summary, and null once it is gone", async () => {
    const { store, busy } = await seedBoard();
    const { api, call } = captureMethods();
    registerWorkboardGatewayMethods({ api, store });

    await expect(call("workboard.cards.get", { id: busy.id })).resolves.toEqual({ card: busy });
    const { card } = await call("workboard.cards.get", { id: busy.id, view: "summary" });
    expect(card).toMatchObject({ id: busy.id, summary: { comments: 2 } });
    expect(card).not.toHaveProperty("notes");
    await store.delete(busy.id);
    await expect(call("workboard.cards.get", { id: busy.id })).resolves.toEqual({ card: null });
  });
});

describe("workboard named changes", () => {
  it("names the cards a change wrote and nothing when a board or the epoch changed", async () => {
    const store = createWorkboardSqliteTestStore();
    const changes: WorkboardChange[] = [];
    store.subscribeChanges((change) => changes.push(change));

    const card = await store.create({ title: "Named" });
    await store.addComment(card.id, { body: "hello" });
    await store.upsertBoard({ id: "planning" });
    store.announceChangeEpoch();

    expect(changes.map((change) => change.cardIds)).toEqual([
      [card.id],
      [card.id],
      undefined,
      undefined,
    ]);
  });
});
